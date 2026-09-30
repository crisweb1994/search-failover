# search-failover — MVP 功能规格文档

| 项 | 值 |
|---|---|
| 版本 | v1.2.1（定稿 + 实现修订 + 市场调研后裁剪 + 接口微调） |
| 日期 | 2026-09-29 |
| 状态 | 已拍板；实现规格见 [impl-spec.md](impl-spec.md)，评审通过后动工 |
| 实现语言 | **TypeScript + Node.js ≥ 20**（v1.1 拍板，详见 impl-spec.md） |
| 部署形态 | 本地 stdio MCP（单客户端） |

---

## 1. 项目概述

### 1.1 一句话定位

一个搜索聚合网关 MCP：对外暴露统一的 `search` 工具，内部将多个第三方搜索 API 池化，任一来源限额、超时、空结果时自动切换下一家，让 agent 永远不必关心"哪家搜索又没额度了"。

### 1.2 解决的痛点

第三方搜索 MCP / API 普遍存在额度限制（按秒、按月、一次性 credit），额度耗尽时 agent 工作流被打断。本网关把多个免费/低成本来源池化为一个高可用搜索入口。

### 1.3 设计原则

1. **网关不解决限额本身，只做池化容灾**——上游配额总和就是天花板（业内第五派"网关路由派"的定位）。
2. **极简工具面**——只暴露 `search` + `status` 两个工具，agent 零选择成本。
3. **过程透明**——每次调用的 fallback 决策链完整返回给调用方。
4. **被动信号优先**——以服务端返回的限额/错误信号驱动摘除，本地只做轻量内存计数，不做持久化记账（MVP）。
5. **免费优先、付费兜底靠后**——一次性 credit 源（Exa）省着用，无限源（DDG）永远垫底。

---

## 2. 决策记录（本节为探讨结论的固化，实现时不再讨论）

| # | 决策 | 结论 | 依据摘要 |
|---|---|---|---|
| D1 | 聚合形态 | **API 直连为主**；远程 MCP provider 留 V3，不代理 stdio MCP | MCP-of-MCP 限额信号衰减、进程管理复杂 |
| D2 | 默认路由策略 | **顺序兜底 + cooldown** | 最省配额，贴合痛点 |
| D3 | 空结果处理 | **`no_results` 触发 fallback：直接切下一家、不重试、不惩罚源健康度** | daedra "first one that returns results wins"；reliable-web-search `no_results → next provider directly (no retry)` |
| D4 | 中文源 | **博查第一版即接入，默认排第 1 位**；顺序是配置项，上线后按 `status` 观察调整 | reliable-web-search 将博查/秘塔列为一等公民；博查有免费通道且兼容 Bing API 格式（Bing 官方 API 已于 2025-08 退役） |
| D5 | 配额记账 | **SQLite 记账不进 MVP**。MVP 只做：内存计数 + `status` 展示 + 服务端配额信号触发"摘除到重置时间点" | 个人轻量流派（reliable-web-search / mcp-web-search）均不做持久记账；免费月配额合计约 3000 次 + DDG 无限，个人用量通常烧不完。**迁移触发条件：任一 provider 月配额真的烧完并影响使用 → V2 引入 SQLite** |
| D6 | ~~重试克制~~ → **不做同源重试**（v1.2 反转） | 任何错误一律直接切下一家；failover 即重试 | 15 家同类调研：搜索侧对可互换的结果，主流是失败即换（openclaw / pi-search-hub 等）；同源重试只增加延迟与退避逻辑（约一半项目保留分类重试，如 daedra，属可选分歧点） |
| D7 | 永不永久摘除 | cooldown 有上限；除 `auth_failure` 外任何源不被长期禁用 | Envoy panic threshold / OpenRouter"故障源降级到队尾而非踢掉" |
| D8 | 健康管理（v1.2 新增） | **每源一个结构 `{blockedUntil, reason, failStreak}`**：按错误类别定初始屏蔽时长，重复失败阶梯翻倍封顶；auth = ∞；**无状态机 / 熔断 / half-open** | 15 家同类无一实现多状态机；LiteLLM / OpenRouter / openclaw / codebuddy 全部是"时间戳 + 计数器"，codebuddy 甚至只是一张 status→时长映射表 |
| D9 | 缓存（v1.2 新增） | **最简 TTL Map**：两档 TTL（1h / freshness=day 15min）+ 条数上限 FIFO；无 LRU 精细实现 / 负缓存 / single-flight | 多数同类无缓存；负缓存零先例、single-flight 仅 1 家（并发大户场景）；D5 已论证配额烧不完 |
| D10 | 参数面（v1.2 新增，v1.2.1 微调） | **6 参数**：query / max_results / freshness / **include_domains（v1.2.1 加回）** / provider / use_cache；砍 exclude_domains、min_results（硬编码 ≥1 条即胜出） | 同类 MCP 参数面中位数；域名过滤经复核为业内过半标配（Anthropic `allowed_domains`、Tavily/Exa 官方 MCP、tldw `site_whitelist`），coding agent 真实高频需求 |

---

## 3. 系统架构

### 3.1 模块结构（语言无关）

```
┌─────────────────────────────────────────────┐
│ MCP Server (stdio)                          │
│   tools: search / status                    │
├─────────────────────────────────────────────┤
│ Router                                      │
│   按优先级顺序遍历可用 provider              │
├──────────────┬──────────────────────────────┤
│ Health (D8)  │ 每源 {blockedUntil, reason,  │
│              │ failStreak} 阶梯冷却         │
├──────────────┼──────────────────────────────┤
│ QuotaCounter │ 内存计数 + quota profile     │
├──────────────┼──────────────────────────────┤
│ Cache (D9)   │ 内存 TTL Map + 条数上限      │
├──────────────┼──────────────────────────────┤
│ Normalizer   │ URL 规范化 + 去重            │
├──────────────┴──────────────────────────────┤
│ Provider Adapters ×5                        │
│   bocha / tavily / brave / exa / duckduckgo │
│   统一接口 + 各自错误分类映射                │
└─────────────────────────────────────────────┘
```

### 3.2 一次 `search` 调用的生命周期

```
search(req):
  1. q = normalize_query(req.query)            # trim / 小写 / 折叠空白（仅用于缓存 key）
     key = hash(q, freshness)
  2. 若 use_cache 且 provider 未强制指定 且 cache 命中:
       返回缓存（按 max_results 截断），meta.cache_hit = true
  3. deadline = now + total_budget_ms          # 单次调用总预算，缺省 30s（v1.1）
     for p in ordered_providers:               # 按配置优先级
       if p.blockedUntil > now:                # D8：冷却/摘除/disabled 统一为一个时间戳
           fallback_chain += {p, "skipped: " + p.reason}; continue
       if now >= deadline:                     # 预算耗尽：剩余源记 skipped 后收尾
           fallback_chain += {p, "skipped: budget_exhausted"}; continue
       res = p.search(req, timeout = min(10s, 剩余预算))    # 任何错误不重试，直接切（D6 v1.2）
       ├── 成功且 len(res) >= 1:
       │      quota_counter.tick(p); p.failStreak 清零
       │      results = normalize_and_dedupe(res)
       │      cache.put(key, results)
       │      return {results, meta}           # meta.provider_used = p
       └── 抛 ProviderError(e):
              health.block(p, e.class)         # 按类别定 blockedUntil，重复失败阶梯翻倍
              fallback_chain += {p, e.class}
              continue
  4. 全部源耗尽:
       返回 {results: [], meta: {fallback_chain, error_summary}}  # 结构化空结果，非报错
```

---

## 4. 对外接口规范

### 4.1 `search` 工具

**参数：**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 搜索词 |
| `max_results` | int | 8 | 返回条数上限，1–20 |
| `freshness` | enum | – | `day / week / month / year`，时效过滤 |
| `include_domains` | string[] | – | 仅返回这些域名的结果（v1.2.1 加回：Tavily/Exa 原生支持，Brave 单域名 `site:`，博查/DDG 忽略并在 note 透出） |
| `provider` | string | – | 强制指定单一源（调试用；指定时绕过缓存） |
| `use_cache` | bool | true | 是否允许命中缓存 |

**返回（统一 schema）：**

```json
{
  "results": [
    {
      "title": "…",
      "url": "…",
      "snippet": "…",
      "score": 0.87,
      "published_date": "2026-09-01",
      "content": "…（仅 Tavily/Exa/博查(summary) 等带内容抽取的源有此字段）",
      "provider": "tavily"
    }
  ],
  "meta": {
    "provider_used": "tavily",
    "fallback_chain": [
      {"provider": "bocha", "outcome": "no_results"},
      {"provider": "tavily", "outcome": "rate_limited(cooldown 60s)"},
      {"provider": "tavily", "outcome": "ok"}
    ],
    "cache_hit": false,
    "elapsed_ms": 820,
    "note": "当 fallback_chain 中出现 skipped/cooldown 条目时此字段聚合原因摘要"
  }
}
```

**空结果语义：** 所有源均无结果时返回 `results: []` + 完整 `fallback_chain`，**不返回错误**——"全网都没搜到"本身是有信息量的答案，agent 可据此改写查询。

### 4.2 `status` 工具

无参数。返回网关实时仪表盘：

```json
{
  "providers": [
    {
      "name": "brave",
      "state": "active | blocked(rate_limited, 剩42s) | blocked(quota_exhausted, 至10-31) | disabled(auth) | unconfigured",
      "fail_streak": 0,
      "used_this_month": 312,
      "quota_profile": "monthly:2000",
      "quota_warning": false,
      "last_error": "429 at 2026-09-29T10:32:11"
    }
  ],
  "cache": {"entries": 210, "hits": 58, "misses": 141},
  "uptime_s": 86400
}
```

---

## 5. Provider 规范

### 5.1 首批五个 Provider 与配额 Profile

| 优先级 | Provider | 免费档 | quota_profile | 备注 |
|---|---|---|---|---|
| 1 | **博查 Bocha** | 平台免费通道（LangSearch，条款额度以平台页为准）；付费 ¥0.036/次 | `monthly:<额度按平台>` | 中文最强；响应格式兼容 Bing API；`POST https://api.bochaai.com/v1/web-search` |
| 2 | Tavily | 1000 credits/月（basic 1 credit/次，advanced 2） | `monthly:1000`（按次计，advanced ×2） | 带内容抽取，agent 友好 |
| 3 | Brave | 2000 次/月 + 1 QPS | `monthly:2000` + 本地 1 QPS 限速 | 传统 web 搜索质量好 |
| 4 | Exa | 一次性 $10 credit | `never:估算次数` | 一次性 credit，**省着用**，语义检索强 |
| 5 | DuckDuckGo | 无 key、无官方限额 | `unbounded` | 兜底；无官方 API，走 HTML 端点自解析；限流表现为 **HTTP 202 异常页**、封禁为 403/challenge 页——均按 `rate_limited` 分类，但走该源独立 `cooldown_max_s` 覆盖（缺省 6h，v1.1） |

> 五家的"配额耗尽"信号已按官方文档核对并固化到 [impl-spec.md](impl-spec.md) §8 映射表：博查 HTTP 403（余额不足）、Tavily 432/433、Brave 429 响应体 `error.code` 可区分 `QUOTA_LIMITED`（月配额）与 `RATE_LIMITED`（秒级限速）、Exa 402、DDG 202/403。配额数字以官网当前页面为准。

**默认优先级即上表顺序**（D4）。顺序是配置项：上线后观察 `status` 两周，按实际查询语言构成调整（中文占比高保持现状；英文为主可把 Tavily 提到第 1）。

### 5.2 ProviderAdapter 接口契约

每个 adapter 实现两个职责：

```
search(SearchRequest, timeout) -> SearchResult[]      # 统一字段的原始结果
classify(status, headers, body) -> ErrorType          # 把该家的 HTTP 信号映射为六类标准错误
```

- 请求参数映射：`max_results/freshness` 五家均支持（freshness 映射表见 impl-spec §8），无降级场景（v1.2 参数面收窄后）。
- 返回字段映射为统一 schema（见 §9）；无对应字段则留空（如 Brave 无 score、DDG 无 published_date）。
- API key 一律从环境变量读取（见 §10）。

---

## 6. 错误分类与路由策略

### 6.1 六类标准错误（核心表）

| ErrorType | 信号（adapter 映射） | 动作（v1.2 统一为：切下一家 + 设 blockedUntil） | blockedUntil |
|---|---|---|---|
| `rate_limited` | HTTP 429；`Retry-After` / `X-RateLimit-Reset` 头；DDG 的 202 异常页与 403 challenge | 切下一家 | `now + Retry-After`（缺省 60s，封顶 3600s；DDG 被封走该源覆盖 6h） |
| `quota_exhausted` | 博查 403（余额不足）；Tavily 432/433；Brave 429 且 `error.code=QUOTA_LIMITED`；Exa 402 | 切下一家 | 重置点（月度制：per-provider `reset_day`；余额制/一次性 credit：`now + quota_retry_s` 缺省 6h） |
| `auth_failure` | HTTP 401（Brave 为 422 + `SUBSCRIPTION_TOKEN_INVALID`） | 切下一家；`status` 标红 | ∞（仅修配置重启） |
| `timeout` / `network` | 请求超时（默认 10s）/ 连接失败 / DNS | **切下一家，不重试**（D6 v1.2） | `now + 30s` |
| `server_error` | HTTP 5xx（未识别 4xx 走同一路径） | 切下一家 | `now + 60s` |
| `no_results` | 正常返回但 0 条 | **直接切下一家；不惩罚健康度**（D3） | 不屏蔽 |

> **阶梯翻倍（D8）**：除 quota / auth / no_results 外，重复失败按 `初始时长 × 2^failStreak` 翻倍，封顶该源 `cooldown_max_s`——这就是全部的"熔断"。"到点放行"即试探：下一次请求失败自然再拉长冷却，成功即清零。未识别 4xx（如 Tavily 422、Brave `VALIDATION`）按 `server_error` 路径处理但 detail 保留原始状态码（意味着我方请求构造有 bug，冷却只为防连环撞击）。

### 6.2 健康管理（v1.2：一个结构替代状态机）

每个 provider 只有一份状态：

```
{ blockedUntil: 时间戳, reason: string, failStreak: number }
```

- `record(err)`：按 §6.1 类别定初始时长 × `2^failStreak`（封顶该源 `cooldown_max_s`），`failStreak++`，写入 `blockedUntil`/`reason`；quota 类不用阶梯（直接到重置点）；auth 写 ∞。
- `recordSuccess()`：`failStreak` 清零。
- 路由时只做一件事：`now < blockedUntil ? 跳过(reason) : 放行`。

半开、熔断、摘除三种状态的转移逻辑，被"到点放行 + 失败阶梯翻倍"这一个乘法自然覆盖。约束（D7）依旧成立：任何自动屏蔽都有上限时长。依据（D8）：15 家同类调研，冷却实现全部是"时间戳 + 计数器"。

---

## 7. 缓存设计（内存实现）

| 项 | 规则 |
|---|---|
| 缓存 key | `hash(normalized_query + freshness + sorted(include_domains))` |
| query 归一化 | trim → 小写 → 折叠连续空白（**仅用于 key，上游收原始查询**） |
| `max_results` 不进 key | 缓存**固定存 `store_size` 条**（缺省 20 = `max_results` 参数上限；实际请求量取 `min(store_size, 该源单次上限)`），命中后截断到请求的 `max_results`。请求值恒 ≤ store_size，不存在"存少取多"场景（v1.1 修订） |
| TTL 普通查询 | 3600s |
| TTL `freshness=day` | 900s（时效敏感降 TTL） |
| 容量 | 内存 Map + 条数上限（缺省 512），超限逐最旧（FIFO；v1.2 砍 LRU/负缓存/single-flight，D9） |
| 绕过条件 | `use_cache=false` 或 强制指定 `provider` |

---

## 8. 配额管理（MVP 简化版，D5）

1. **内存计数**：per provider 计当月调用次数，`status` 展示；重启清零（接受）。
2. **本地预警不强制**：达到 profile 上限 90% 时 `status` 置 `quota_warning=true`，但不主动摘除——**真实摘除只由服务端信号触发**（本地计数可能与真实配额漂移）。
3. **服务端信号是唯一摘除依据**：`quota_exhausted` → 摘到 profile 重置时间点。
4. **QPS 类限速（Brave 1QPS）**：adapter 内本地令牌桶，请求间隔不足时本地等待（≤1s）而非消耗上游 429。

---

## 9. 结果归一化与去重

**URL 规范化（去重键）：** host 小写、去默认端口、去尾斜杠、剥追踪参数（`utm_*`、`fbclid`、`gclid` 等）；保留原 scheme 与路径。

**去重规则：** 同一规范化 URL 多条结果时，保留**信息更全的一条**（`content`/`snippet` 总长度更长者优先）；`provider` 字段记录被保留条的来源。

**score 不强行对齐：** 各家分数量纲不可比（Brave 无分、Exa/Tavily 0–1）。MVP 保留原值并透传 provider，不做跨源归一（跨源融合排序属 V2 aggregate 模式）。

---

## 10. 配置规范

配置文件（JSON）+ 环境变量（密钥不落盘）：

```json
{
  "providers": [
    {"name": "bocha",      "enabled": true, "priority": 1, "quota": {"type": "monthly", "limit": 1000, "reset_day": 1}},
    {"name": "tavily",     "enabled": true, "priority": 2, "quota": {"type": "monthly", "limit": 1000, "reset_day": 2}},
    {"name": "brave",      "enabled": true, "priority": 3, "quota": {"type": "monthly", "limit": 2000, "reset_day": 15}, "local_qps": 1},
    {"name": "exa",        "enabled": true, "priority": 4, "quota": {"type": "one_time", "quota_retry_s": 21600}},
    {"name": "duckduckgo", "enabled": true, "priority": 5, "quota": {"type": "unbounded"}, "cooldown_max_s": 21600, "min_interval_ms": 2000}
  ],
  "defaults": {"max_results": 8, "timeout_ms": 10000, "total_budget_ms": 30000, "cooldown_default_s": 60, "cooldown_max_s": 3600},
  "cache": {"enabled": true, "store_size": 20, "ttl_s": 3600, "ttl_fresh_s": 900, "max_entries": 512}
}
```

> `reset_day` 为 per-provider 配置（v1.1）：Tavily 按注册周年日、Brave 按订阅日、博查免费通道按平台规则——上表数值是占位示例，各自查后台后填。余额制/一次性 credit（Exa、博查付费档）没有月度重置点，用 `quota_retry_s` 探针间隔替代。

环境变量：`BOCHA_API_KEY`、`TAVILY_API_KEY`、`BRAVE_API_KEY`、`EXA_API_KEY`。未配置 key 的 provider 自动跳过（`status` 中标注 `unconfigured`），不影响其余源。

---

## 11. 范围界定

### In Scope（MVP 必做）

- 5 个 provider adapter（博查 / Tavily / Brave / Exa / DDG）
- 顺序兜底路由 + 六类错误分类 + blockedUntil 阶梯冷却（无状态机 / 熔断 / half-open，D8）
- `no_results` 触发切换；任何错误不做同源重试，failover 即重试（D3 / D6 v1.2）
- 内存 TTL 缓存（key 归一化、两档 TTL、条数上限，D9）
- 内存配额计数 + `status` 预警
- URL 规范化去重、统一结果 schema、fallback 决策链透出
- `search`（6 参数）+ `status` 两工具，stdio 传输，接入 MCP 宿主

### Out of Scope（明确不做，留待后续）

| 功能 | 版本 | 迁移触发条件 |
|---|---|---|
| SQLite 持久缓存 + 持久配额记账 | V2 | 任一 provider 月配额真的烧完并影响使用（D5） |
| aggregate 并发聚合模式 + RRF 融合排序 | V2 | 对单源结果质量不满意时 |
| 多 key 轮换（同源 key 池） | V2 | 免费档 QPS/月配额成为瓶颈时 |
| 远程 MCP provider 接入 | V3 | 出现"只有托管 MCP 形态"的优质源时 |
| 竞速 race 模式 | V3 | 延迟成为首要诉求时 |
| 垂直搜索（news/academic/images） | V3 | 有真实需求时 |
| fetch/extract 网页抓取工具 | V3 | 与搜索解耦，另议 |
| 远程部署（streamable HTTP）+ 集中账本 | V3 | 多客户端共享网关时 |
| 按查询语言动态路由 | 不做 | 静态顺序 + 观察手调足够（D4） |

---

## 12. 验收标准（MVP 完成的定义）

以下每条均可用 mock 上游或真实 key 测试：

1. **契约**：5 个 adapter 各自通过契约测试（mock HTTP：正常 / 429 / 402 / 401 / 5xx / 超时 / 空结果七种响应各验证一次分类正确）。
2. **429 切换**：首选源返回 429 时请求自动切到下一家成功；`meta.fallback_chain` 记录原因；冷却期内该源被 `skipped`。
3. **配额摘除**：mock 配额耗尽信号 → 源进入 `quota_paused` 至重置时间点；`status` 可见。
4. **auth 摘除**：mock 401 → `disabled`，不参与路由，`status` 标红。
5. **空结果切换**：DDG 返回 0 条时切到下一家；DDG `fail_streak` 不增加、无屏蔽。
6. **无同源重试**：timeout 时直接切换下一家，不发生第二次同源请求；全链路每个源至多消耗 1 次请求（v1.2 修订，原"重试克制"反转）。
7. **缓存**：同参数二次调用 `cache_hit=true` 且上游调用数为 0；`freshness=day` 命中短 TTL（v1.2 移除负缓存断言）。
8. **去重（同源）**：单一源返回内部重复 URL（含 `utm_*` 差异）时仅出一条，保留信息更全者。（v1.1 修订：顺序兜底下单次响应只含一家结果，跨源去重移至 V2 aggregate 验收。）
9. ~~**降级透出**~~（v1.2 移除：参数面收窄到 5 参数后，五家均支持全部入参，无降级场景）。
10. **全源耗尽**：所有源不可用时返回 `results: []` + 各源失败摘要的结构化响应，进程不崩溃。
11. **宿主接入**：stdio 起服后，MCP 宿主（ZCode / Claude Code 等）能发现并成功调用 `search` 与 `status`。
12. **无 key 容错**：仅配置 1 个 key 时其余源自动跳过，网关正常工作。
13. **总预算**：把 `total_budget_ms` 调小并 mock 各源慢响应，预算耗尽后立即返回空结果 + `skipped: budget_exhausted` 摘要，不再请求剩余源（v1.1 新增）。

---

## 附录 A：设计依据（业内模式对照）

| 本设计 | 业内出处 |
|---|---|
| 六类错误 → 不同处置 | OpenRouter 失败模式分层表；reliable-web-search 错误路由表（与我们同构）；codebuddy status→冷却时长映射 |
| 时间戳冷却 + 失败计数（无状态机，D8） | LiteLLM / OpenRouter / openclaw / codebuddy 全部同款；15 家调研无一做 half-open |
| `quota_exhausted` 屏蔽到重置点（区别于普通冷却） | 避免每日白撞 429/402 数百次——"玩具与工具的分水岭" |
| 顺序兜底、故障源不永久踢除 | OpenRouter"30 秒内有故障的源降到队尾"；Envoy panic threshold |
| 不做同源重试，failover 即重试（D6 v1.2） | openclaw / pi-search-hub / taka499 等；对可互换的搜索结果，切换比重试信息增益更大 |
| URL 规范化去重 | 元搜索引擎标准做法（SearXNG / MetaCrawler） |
| 免费优先 + 一次性 credit 省着用 | argus tier 路由（tier0 免费 → tier1 月度 → tier3 一次性） |
| `status` 工具 | k8s /healthz + Prometheus 惯例 |

## 附录 B：参考项目

- reliable-web-search — 两层 failover（同源换 key → 换源）、熔断、fallback/race/aggregate（github.com/leecdiang/reliable-web-search）
- search-fusion-mcp — 限额切换 + cooldown + 统一响应（github.com/sailaoda/search-fusion-mcp）
- mcp-web-search — fallback/merge 双模式、令牌桶、持久缓存（github.com/DmitriyOT/mcp-web-search）
- argus — 14 源分层预算路由（github.com/Khamel83/argus）
- daedra — "first one that returns results wins" 的顺序兜底（github.com/dirmacs/daedra）

## 修订记录

- **v1.2.1（2026-09-29，接口复核后微调 + 实现完成）**：① `include_domains` 加回（D10 微调，业内过半标配）；② 返回砍 `siteName` 字段（业内无人消费）；③ `content` 每条截断 2000 字符、`snippet` 统一由 content 前 300 字兜底；④ `published_date` 在工具描述中标注"尽力而为"；⑤ **实现完成**：TypeScript + Node ≥20，src ~1240 行 / test ~920 行，70 用例全绿（unit + 五家 msw 契约 + Router FakeProvider 集成 + stdio e2e 含 stdout 纯净性守卫）。
- **v1.2（2026-09-29，市场调研后裁剪）**：调研 15 家同类产品（见 impl-spec 附录），核心结论"骨架对齐主流、弹力层超标"。① D6 反转：砍同源重试，failover 即重试；② 新增 D8：五状态机 + half-open + 独立熔断坍缩为 `{blockedUntil, reason, failStreak}` 阶梯冷却；③ 新增 D9：缓存降为最简 TTL Map（砍 LRU 精细实现/负缓存/single-flight）；④ 新增 D10：参数面收窄到 5 参数（砍 domains / exclude_domains / min_results，硬编码 ≥1 条即胜出）；⑤ 砍配额用量回填（Tavily usage.credits / Exa costDollars / Brave X-RateLimit-Remaining，零先例，本地计数够用）；⑥ 验收 6 改为"无同源重试"、7 移除负缓存断言、9 移除。估算代码量从 ~2000 行降到 ~700–900 行。
- **v1.1（2026-09-29）**：① 实现语言定为 TypeScript + Node.js ≥ 20；② 新增单次调用总预算 `total_budget_ms`（缺省 30s，§3.2 / §6 / §10 / 验收 13）；③ §7 缓存存储语义改为固定 `store_size`（缺省 20）；④ DDG 被封的"长冷却"改为 per-provider `cooldown_max_s` 覆盖（缺省 6h），消除与全局 3600s 上限的冲突（§5.1 / §6.1 / §10）；⑤ 配额重置点改为 per-provider `reset_day`，新增余额制 `one_time` + `quota_retry_s` 探针间隔（§6.1 / §6.2 / §10）；⑥ 验收 8 改为同源去重，跨源去重移至 V2；⑦ 五家配额耗尽信号已按官方文档核对（博查 403、Tavily 432/433、Brave `QUOTA_LIMITED`、Exa 402、DDG 202/403），固化于 impl-spec.md §8。
