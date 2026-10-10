# search-failover 第一轮简化技术方案

日期：2026-10-09

代码基线：0.4.0，`9503f65`

状态：已实施并通过本地验收，尚未发布。

本轮只处理两件事：分开本地请求预算与上游配额错误的恢复规则；统一按需取数并简化缓存。沿用现有模块和依赖，不增加后台任务或新的状态管理组件。

## 1. 问题与目标

当前相关实现位于 [配置解析](src/config.ts)、[来源状态](src/state.ts)、[路由](src/router.ts)、[缓存](src/cache.ts) 和 [搜索工具](src/tools/search.ts)。

| 问题 | 当前行为 | 目标行为 |
| --- | --- | --- |
| 本地窗口影响上游恢复 | `quota_exhausted` 没有上游恢复时间时，monthly 来源按本地 reset_day 屏蔽 | 有明确上游时间则采用，否则经过固定间隔允许再试 |
| 缓存改变取数数量 | cache_fill 按 store_size 取数，as_requested 按请求取数 | 所有来源统一按 max_results 取数，受 adapter.maxCount 限制 |
| 按需结果难以缓存 | 缓存 key 不含条数，as_requested 只有取满 store_size 才写入 | 条数进入 key，任何合法非空结果都可缓存 |

前一轮本地复现确认：博查默认配置在 10 月 9 日遇到没有恢复时间的 quota_exhausted，会屏蔽到 11 月 1 日；默认 Exa 的相同 8 条请求连续两次均不入缓存；store_size=2 会把请求 8 条的首次取数压到 2 条。这些是本地逻辑证据，未调用真实供应商。

## 2. 改动边界

保留顺序 fallback、来源数量和优先级、opt-in、本地预算默认值、同步准入计数、限速、单源超时、总预算、请求取消、响应校验、去重和错误分类。

保留现有 TTL、LRU、容量上限、过期清扫、缓存统计、缓存命中的降级说明，以及 search/status 返回结构。

本轮不调整来源顺序配置，不改变 include_domains 的降级语义，不新增来源，不改供应商请求结构，不引入持久化、single-flight、重试队列或后台探测。实际取数参数会按本方案改变。

## 3. 本地预算与上游恢复解耦

### 3.1 配置职责

继续使用 quota 表达本地请求预算，避免整体改名带来的迁移成本。将 quota_retry_s 移到 provider 顶层，表示上游配额错误缺少恢复时间时的等待间隔。

```json
{
  "providers": [
    {
      "name": "bocha",
      "quota": {
        "type": "monthly",
        "limit": 1000,
        "reset_day": 1
      },
      "quota_retry_s": 21600
    },
    { "name": "tavily" },
    { "name": "brave" },
    { "name": "exa" },
    { "name": "duckduckgo" }
  ]
}
```

示例列出完整默认链，因为 providers 仍整体替换默认名单。各条目继续继承来源默认配置。

| 字段 | 唯一职责 |
| --- | --- |
| quota.type | monthly 本地窗口、one_time 进程累计、unbounded 无本地上限 |
| quota.limit | 本进程允许批准的请求尝试次数 |
| quota.reset_day | monthly 本地计数窗口的重置日 |
| provider.quota_retry_s | 上游配额错误没有有效恢复时间时的等待秒数，默认 21600 |

quota_retry_s 延续有限非负数校验；0 表示不施加该类健康冷却，仍受本地预算与限速约束。状态依旧只保存在进程内，重启清零。

### 3.2 健康恢复规则

GatewayState.block 的 quota_exhausted 分支按以下规则计算 blockedUntilMs：

```ts
const resetAt = err.resetAtMs;
const hasFutureReset = resetAt !== undefined
  && Number.isFinite(resetAt)
  && resetAt > now;

h.blockedUntilMs = hasFutureReset
  ? resetAt
  : now + cfg.quota_retry_s * 1000;
```

不读取 quota.type、limit 或 reset_day。有效的未来上游时间直接采用；缺失、非有限或已过期的时间使用固定等待间隔。该分支不参与失败阶梯，也不受普通错误 cooldown_max_s 截短，避免默认 6 小时被全局 1 小时上限覆盖。

rate_limited、auth_failure、timeout、network、server_error、request_error 和 no_results 保持当前处理规则。

冷却到期只意味着下一次用户搜索允许尝试该来源，不自动发请求，也不保证恢复成功。再次收到 quota_exhausted，就从该次错误重新计算等待时间。

### 3.3 本地预算规则

used/tryStart/counter 的职责保持：monthly 在访问计数时识别新窗口；one_time 按进程累计；unbounded 继续计数但不设本地闸门。

tryStart 必须保持同步检查和计数，避免并发超发。上游错误、合法空结果、批准后的取消均计数；缓存命中和等待期间取消不计数。

健康屏蔽与本地预算分别检查，等待后的健康重查和最终准入继续保留：

- 健康冷却结束，但本地预算用完：仍跳过，记录 skipped:quota_local。
- 本地窗口重置，但上游恢复时间未到：仍按健康原因屏蔽。
- 两者都允许：才执行上游请求。

status 保留现有字段和状态优先级，used_this_month 继续作为兼容别名，不新增一套诊断字段。

### 3.4 删除与保留

删除 GatewayState.nextReset，以及仅用于推算未来屏蔽时间的 nextResetMs。monthStart/windowStart/periodKey 保留，用于本地月度计数，并通过路由准入测试验证月末和跨月边界。

注册表删除各 quotaDefault 中重复的 quota_retry_s，由 providerSchema 提供统一默认值。本轮不为所有来源增加相同的显式顶层字段。

## 4. 缓存统一按需取数

### 4.1 路由只决定搜索执行

fetchCount 统一为：

```ts
const fetchCount = Math.min(req.maxResults, p.adapter.maxCount);
```

取数数量不再依赖 cache.enabled、use_cache、provider、fetch_policy 或 store_size。所有来源、所有缓存模式使用同一规则。

max_results 仍是条数上限，不保证足量。上游返回较少结果或去重后变少时，返回实际结果；不为补足条数追加请求，也不将多个来源的结果合并。

### 4.2 缓存 key 包含请求条数

cacheKey 的输入变为：

```ts
cacheKey(normalizeQuery(query), req.maxResults, req.freshness, req.includeDomains);
```

保留现有查询归一化、域名排序和散列方式，仅将 maxResults 以明确分隔符加入散列输入。

同查询的 3 条与 8 条请求使用不同 key。无论结果实际有几条，都以用户请求条数生成 key，不根据实际长度或来源最大条数改变 key。

use_cache=false 和指定 provider 仍绕过读写；全局关闭缓存同样绕过读写。因此无需将这些开关或 provider 加入 key。

### 4.3 工具层统一缓存写入

runSearch 完成去重并返回结果后，工具层先生成 `results.slice(0, req.maxResults)`，以这份结果同时用于缓存和输出，防止上游超量返回进入缓存。

```ts
const results = outcome.results.slice(0, req.maxResults);
if (cacheUsable && results.length > 0) {
  deps.cache.put(key, results, req.freshness === 'day');
}
```

不再查询获胜来源的 fetch_policy，不检查是否取满 store_size。请求 8 条但上游只返回 3 条，仍可缓存；下次相同 8 条请求命中这 3 条。需要重新搜索时使用 use_cache=false。

空结果、错误和取消请求不写缓存。命中时继续重建获胜来源的 adapter.note，保留查询截断提示；fallback_chain 为空，不重放上次失败链，缓存命中不消耗上游请求次数。

ResultCache 的存储结构、两档 TTL、LRU 和清扫规则保持。缓存 key 改动不需要数据迁移，因为缓存只在进程内存在。

## 5. 旧配置兼容

兼容只发生在配置解析入口，归一化后的 AppConfig/ProviderCfg 不含废弃字段。路由、缓存和状态模块不得保留旧策略分支。

| 旧字段 | 处理方式 |
| --- | --- |
| quota.quota_retry_s | 验证后提升到 provider.quota_retry_s；两者同时存在时顶层值优先 |
| provider.fetch_policy | 接受原有合法枚举，移除，不再影响取数 |
| cache.store_size | 接受原有合法范围 1–20，移除，不再影响取数或写缓存 |

规范化在合并来源默认值之前完成，避免默认 quota_retry_s 覆盖用户旧值，或 quota 类型切换丢失旧值。旧值和新值均须验证，不能用新字段掩盖非法旧字段。

parseConfig 保持纯解析函数。废弃字段的兼容只发生在解析入口，不输出迁移提示——实施时线上尚无存量用户，提示没有受众。

旧文件仍能启动，但旧取数策略不再生效。这是有意的行为调整，README 和 CHANGELOG 必须明确说明。兼容入口移除时间不在本轮决定。

## 6. 行为变化与代价

| 场景 | 实施后 |
| --- | --- |
| monthly 来源收到无恢复时间的 quota_exhausted | 默认等待 6 小时，不推算到本地月度重置日 |
| 上游给出有效未来恢复时间 | 屏蔽到该时间，不提前发探测请求 |
| 同参数 Exa 查询请求 8 条 | 非空结果可缓存，下一次可命中 |
| 旧 store_size=2，请求 8 条 | 向上游请求最多 8 条；旧字段不再限制取数 |
| 同查询先请求 8 条，再请求 3 条 | 分别缓存，第二种条数首次调用需请求上游 |
| 相同条数请求但上游只返回少量结果 | 缓存实际非空结果，保留现有 TTL |

不同条数不再共用缓存，可能增加请求次数和缓存条目竞争；删除预取则会减少单次获取的数据量。净成本与延迟变化取决于查询分布和供应商计费，不能仅凭本地测试宣称降低费用。

旧 store_size 较小的用户，单次请求条数可能增加。未知恢复时间采用固定间隔后，永久欠费来源可能在后续用户搜索中定期被再次尝试；本地预算和 opt-in 仍提供原有约束。

## 7. 实施顺序与文件范围

分两批修改，每批通过对应测试后再继续。无需增加生产代码文件、依赖或类。

| 批次 | 文件 | 工作 |
| --- | --- | --- |
| A：恢复解耦 | src/config.ts、src/providers/registry.ts、src/state.ts | 提升 quota_retry_s、兼容旧位置、删除恢复时间推算 |
| A：验证 | test/unit/config.test.ts、test/unit/state.test.ts、test/router.test.ts | 配置迁移、恢复时间与本地窗口独立、并发准入和取消回归 |
| B：缓存简化 | src/config.ts、src/providers/registry.ts、src/router.ts、src/cache.ts、src/tools/search.ts | 删除预取策略、条数加入 key、统一缓存写入 |
| B：验证 | test/unit/cache.test.ts、test/unit/search-tool.test.ts、test/router.test.ts | 替换旧策略断言，验证实际调用次数、取数和缓存边界 |
| 文档 | README.md、README.en.md、CHANGELOG.md、plugin/skills/web-search/SKILL.md、src/index.ts 的工具描述 | 同参数包含条数、TTL 说明、旧字段迁移和行为变化 |

旧测试中“as_requested 短结果不写缓存”“cache_fill 恒取 store_size”“monthly 错误按本地重置点恢复”等断言应替换，不能为了兼容旧断言保留旧执行路径。测试标题和注释也需同步，例如 Exa 的 quota 错误说明。

本方案在两处目标行为上取代本地旧文档 provider-expansion-spec 的 D12 和 reliability-fix-plan 的 §7.1；已在旧文档开头补替代说明，其他仍有效约定继续保留。docs 目录被 Git 忽略，旧文档调整仅存在于本地；本文件是随实现版本管理的方案与验收依据。

实施前核对工作区已有改动，只修改本方案覆盖内容，不覆盖用户修改。本方案制定时 src/index.ts 已有一处未提交空白改动。

## 8. 验收标准

优先验证可观察行为，不新增只断言实现形状的测试。

| 类别 | 必须通过的行为 |
| --- | --- |
| 默认恢复 | monthly、one_time、unbounded 无有效上游恢复时间时均按 quota_retry_s 等待；不读取 reset_day |
| 上游提示 | 有效未来时间被采用；过去、NaN、Infinity 等时间回退到固定间隔 |
| 再次错误 | 冷却后的一次真实路由尝试若再次报配额错误，从这次错误重新计算；没有后台请求 |
| 独立闸门 | 冷却结束但本地预算用完仍 skipped:quota_local；本地窗口重置不提前解除健康屏蔽 |
| 本地窗口 | 经路由准入验证 reset_day、跨月、月末 clamp；one_time 不随月份清零 |
| 并发计数 | limit=1 的三个并发请求只批准一次；错误和批准后取消计数，等待中取消不计数 |
| 配置兼容 | 旧位置提升、新值优先、类型切换保留恢复设置、非法旧值仍拒绝；废弃取数字段不进入最终配置 |
| 取数数量 | 各缓存模式均请求 min(max_results, maxCount)，旧 store_size 不限制数量 |
| 同参数缓存 | 相同条数的 Exa 短结果可缓存，第二次不调用上游，不增加计数 |
| 条数隔离 | 3 条与 8 条请求不互相命中；相同条数但实际返回少量结果可以命中 |
| 缓存绕过 | use_cache=false、指定 provider、全局关闭缓存均不读写缓存 |
| 缓存边界 | TTL、LRU、容量上限、空结果不缓存、取消不缓存、超量返回截断后缓存均成立 |
| 结果解释 | 冷请求和命中均保留相关降级提示；合法空结果和搜索失败的 isError 语义保持 |
| 生命周期 | 取消不继续 fallback、不惩罚健康；总预算耗尽与单源超时仍正确区分 |

完成两批后运行：

```bash
npm run typecheck
npm test
npm run plugin:check
npm run build
node scripts/runtime-smoke.mjs dist/index.js
```

这些建立本地逻辑、清单结构和模拟上游的真实 stdio 子进程证据。真实供应商 smoke 单独记录来源、请求条数、缓存命中和调用结果；没有凭据或未执行时标为未验证，不与本地结果合并。

实施验收已完成：20 个测试文件、194 项测试通过；类型检查、插件清单校验、构建通过；在 Node v24.20.0 上使用构建产物通过 stdio 冒烟，涵盖旧配置启动、同条数命中、不同条数隔离和请求计数。上游为本地模拟响应，未执行真实供应商调用，最低 Node 版本的构建包安装验证留给已有 CI。此前 review 基线为 153 项测试通过。

## 9. 发布与回退

建议作为下一次 minor 行为更新发布，目标版本在正式发布时确定。实现位于 codex/simplify-recovery-cache 分支；本次不修改版本，不推送或发布，也不创建 PR。

发布说明列出恢复规则、缓存条数隔离、废弃字段兼容和成本取舍。实施时沿用现有版本同步、清单校验和发布流程。

回退使用旧发布版本或回退这两批实现，并重启 MCP 进程。旧配置文件未被自动改写，没有持久化缓存或状态迁移；回退不新增线上兼容开关。

完成标准：运行时只保留一种取数规则，恢复分支不再依赖本地窗口；相关旧分支与旧断言已删除，验收通过，文档明确行为变化与实际验证范围。
