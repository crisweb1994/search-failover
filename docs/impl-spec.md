# search-failover — 实现规格（impl-spec）

| 项 | 值 |
|---|---|
| 版本 | v1.2.1（对应 mvp-spec v1.2.1） |
| 日期 | 2026-09-29 |
| 状态 | **已实现**：src ~1240 行 / test ~920 行，70 用例全绿；本文件与代码同步 |
| 技术栈 | TypeScript 5.x（strict）+ Node.js ≥ 20.10 + ESM |
| 规模结果 | 运行时依赖 2 个（MCP SDK、zod）；核心代码 1238 行 + 测试 924 行（v1.2 目标 ~500/350，实际含注释与空行略超，符合预期量级） |

本文档是 [mvp-spec.md](mvp-spec.md) 的实现落地文档。v1.2 依据 15 家同类产品调研做了裁剪（附录 A），核心变化：健康管理坍缩为单结构时间戳（D8）、缓存降为最简 TTL Map（D9）、参数面收窄（D10）、不做同源重试（D6 反转）、砍配额用量回填。v1.2.1 接口微调：`include_domains` 加回、返回砍 `siteName`、`content` 截断 2000 / `snippet` 兜底 300 字符。

---

## 1. 技术选型与工程化

### 1.1 运行时与依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| Node.js ≥ 20.10 | 运行时 | 原生 `fetch`、`AbortSignal.timeout`，不引 HTTP 库 |
| `@modelcontextprotocol/sdk` ^1.x | MCP stdio 服务 | `McpServer` + `StdioServerTransport` + `registerTool` |
| `zod` ^3 | 参数校验与 schema | |
| `vitest` + `msw` ^2（dev） | 单测 + mock HTTP | 契约测试用 |
| `tsx`（dev） | 本地起服调试 | |

DDG 的 HTML 解析用分层正则自实现（§7.5），不引解析库。

### 1.2 目录结构（v1.2：9 模块并成 6 个核心模块）

```
search-failover/
  package.json          # bin: {"search-failover": "dist/index.js"}
  tsconfig.json         # strict, NodeNext, ESM
  vitest.config.ts
  src/
    index.ts            # 入口：读配置 → 组装 → 注册工具 → stdio 起服
    logger.ts           # ~20 行 stderr logger
    config.ts           # zod schema + 默认值 + env key 映射（§9）
    types.ts            # 核心类型（§2）
    state.ts            # 健康屏蔽 + 配额计数 + 限速等待（§4，~100 行，替代原 health+quota）
    router.ts           # 顺序兜底主循环（§3）
    cache.ts            # 最简 TTL Map（§5，~40 行）
    providers/
      types.ts          # ProviderAdapter 接口 + 共享 HTTP 骨架（§7.0）
      bocha.ts  tavily.ts  brave.ts  exa.ts  ddg.ts
    tools/
      search.ts         # search 工具编排
      status.ts         # status 快照
  test/
    unit/               # state / cache / normalize / config
    providers/          # 五家契约测试（msw 表驱动，§10.2）
    router.test.ts      # FakeProvider 场景表（§10.3）
    e2e/stdio.test.ts   # 子进程 + MCP Client（§10.4）
```

URL 规范化/去重并入 `tools/search.ts` 或 `router.ts` 内的小函数（~30 行），不单独成模块。

### 1.3 工程红线

1. **stdout 只允许 MCP 协议帧**，日志全走 stderr（级别 `LOG=error|warn|info|debug`，缺省 info）。CI 守卫测试：起服后断言 stdout 每行可按协议解析。
2. **进程不崩**：handler 全包裹 try/catch，未预期异常记 `internal_error` 结构化返回，绝不抛裸异常。
3. 时间只用 `Date.now()`，屏蔽判断惰性进行，不设定时器。
4. 零持久化（D5）：内存态，重启复位。

---

## 2. 核心类型（src/types.ts 全文）

```ts
export type Freshness = 'day' | 'week' | 'month' | 'year';

/** search 工具归一化入参（v1.2.1：6 参数，D10） */
export interface SearchRequest {
  query: string;          // trim 后的原始查询（保留大小写发上游）
  maxResults: number;     // 1–20
  freshness?: Freshness;
  includeDomains?: string[];  // v1.2.1 加回（D10 微调）
  provider?: string;      // 强制指定源（调试），绕过缓存读写
  useCache: boolean;      // 缺省 true
}

/** 错误分类（timeout/network 动作相同，保留两个标签只为链上信息更准） */
export type ErrorType =
  | 'rate_limited'      // 429 / DDG 202 异常页 / DDG 403 challenge
  | 'quota_exhausted'   // 博查403 / Tavily 432,433 / Brave QUOTA_LIMITED / Exa 402
  | 'auth_failure'      // 401（博查）；Brave 为 422+SUBSCRIPTION_TOKEN_INVALID
  | 'timeout'
  | 'network'
  | 'server_error'      // 5xx；未识别 4xx 走同一路径
  | 'no_results';       // 仅 Router 产生

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly type: ErrorType,
    readonly detail: string,   // 'http_429 retry-after=60s' 等原始信号
    options: { retryAfterMs?: number; resetAtMs?: number; soft?: boolean } = {},
  ) { super(`${provider}:${type}(${detail})`); }
  // retryAfterMs: rate_limited 建议屏蔽时长；resetAtMs: quota 精确恢复点（Brave 第二桶）；
  // soft: 未识别 4xx——走 server_error 冷却路径但不增失败阶梯
}

export interface RawResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  score?: number;
  publishedDate?: string;   // ISO，尽力解析，可空
  siteName?: string;
}

export interface SearchResult extends RawResult { provider: string; }

/** adapter 无状态纯函数；状态全在 state.ts */
export interface ProviderAdapter {
  readonly name: string;
  readonly maxCount: number;
  search(req: SearchRequest, fetchCount: number, signal: AbortSignal): Promise<RawResult[]>;
}

export interface FallbackStep {
  provider: string;
  outcome: string;    // 'ok' | 'no_results' | 'skipped:<原因>' | '<ErrorType>' 
  detail?: string;
  elapsedMs: number;
}

export interface SearchMeta {
  provider_used: string | null;
  fallback_chain: FallbackStep[];
  cache_hit: boolean;
  elapsed_ms: number;
  note?: string;
}
```

---

## 3. Router（src/router.ts）

```ts
async function runSearch(req, deps): Promise<{ results: SearchResult[]; meta: SearchMeta }> {
  const chain: FallbackStep[] = [];
  const deadline = Date.now() + deps.config.totalBudgetMs;

  for (const p of deps.providers) {              // 已按 priority 排序，未配 key 的已剔除
    if (req.provider && p.name !== req.provider) continue;
    const stepStart = Date.now();

    // ① 屏蔽检查（D8：一个时间戳管所有"跳过"语义）
    const blocked = deps.state.checkBlocked(p.name);   // null | {reason, remainS}
    if (blocked) { chain.push(step(p, `skipped:${blocked.reason}`, `${blocked.remainS}s`)); continue; }

    // ② 总预算
    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) { chain.push(step(p, 'skipped:budget_exhausted')); continue; }

    // ③ 限速等待（Brave 1QPS / DDG 礼貌间隔，等待计入预算）
    await deps.state.pace(p.name, budgetLeft);

    // ④ 请求——任何错误不重试，直接切（D6 v1.2）
    try {
      const timeoutMs = Math.min(deps.config.timeoutMs, deadline - Date.now());
      const raw = await p.adapter.search(
        req, deps.fetchCount(p), AbortSignal.timeout(timeoutMs));
      if (raw.length === 0) {                    // no_results：不惩罚不屏蔽（D3）
        chain.push(step(p, 'no_results'));
        continue;
      }
      deps.state.recordSuccess(p.name);
      deps.state.tick(p.name);
      const results = dedupe(normalize(raw)).map(r => ({...r, provider: p.name}));
      return { results: results.slice(0, req.maxResults), meta: buildMeta(chain, p.name, ...) };
    } catch (e) {
      const err = e instanceof ProviderError ? e
        : new ProviderError(p.name, 'network', String(e));   // fetch 网络层异常兜底
      deps.state.block(p.name, err);            // 按类别定 blockedUntil（§4.1）
      chain.push(step(p, err.type, err.detail));
      continue;
    }
  }

  // ⑤ 全部耗尽：结构化空结果，不抛错
  return { results: [], meta: buildMeta(chain, null, ...) };
}
```

关键语义：

| 语义 | 决策 |
|---|---|
| 无重试 | 任何错误（含 timeout）直接切下一家；全链路每源至多 1 次请求（D6 v1.2） |
| 胜出条件 | 非空即胜出（≥1 条，min_results 已硬编码，D10） |
| 总预算 30s | 每跳开始前检查 + `AbortSignal.timeout` 内嵌剩余预算；pace 等待同样受约束 |
| 并发 | MCP 宿主可并发调用：Router 无共享可变状态，state/cache 的同步内存操作在 JS 事件循环下原子，无锁 |
| fetchCount | `min(cache.store_size, adapter.maxCount)`，与请求 maxResults 解耦（缓存复用基础） |
| 强制 provider | 只保留该源；绕过缓存读写；屏蔽状态照样生效（链上可见） |

---

## 4. State（src/state.ts：屏蔽 + 计数 + 限速，~100 行）

### 4.1 健康屏蔽（D8）

```ts
interface PHealth {
  blockedUntilMs: number;   // 0 = 未屏蔽；Infinity = auth
  reason: string;           // 'rate_limited' | 'quota_exhausted' | 'auth_failure' | ...
  failStreak: number;
}
```

- `checkBlocked(name, now)`：`now < blockedUntilMs ? {reason, remainS} : null`——到点自然放行，放行即试探。
- `block(name, err)`：

| err.type | blockedUntil |
|---|---|
| `rate_limited` | `now + (err.retryAfterMs ?? 60s)`，封顶该源 `cooldown_max_s`（全局 3600s / DDG 21600s） |
| `quota_exhausted` | `err.resetAtMs ?? nextReset(name)`（§4.3；不用阶梯） |
| `auth_failure` | `Infinity` |
| `timeout` / `network` | `now + 30s × 2^failStreak`（封顶） |
| `server_error`（含未识别 4xx） | `now + 60s × 2^failStreak`（封顶；未识别 4xx 不增 failStreak） |

- `recordSuccess(name)`：`failStreak = 0`，`blockedUntilMs = 0`。

阶梯翻倍就是全部的"熔断"：连续失败越多冷却越长，成功清零——半开/熔断/摘除的状态转移被这一个乘法覆盖。

### 4.2 配额计数

- `tick(name)`：Router 成功路径 +1，按该源 reset_day 划分月窗。
- 达 profile 上限 90% 时 status 置 `quota_warning`（只预警不摘除，D5）。
- **v1.2 砍掉用量回填**（Tavily `usage.credits` / Exa `costDollars` / Brave `X-RateLimit-Remaining`）——零先例的聪明遥测，不是承重结构；将来想加每个只需几行。Exa 的 status 展示用本地计数折算（`limit` 配置为估算次数）。

### 4.3 nextReset 与限速等待

- `monthly`：下一次该源 `reset_day` 00:00（本地时区）。Brave 的 429 响应头 `X-RateLimit-Reset: "1, 183945"` 第二桶秒数更准——Brave adapter 在 classify 时直接给 `resetAtMs = now + 第二桶`（§7.3）。
- `one_time` / 余额制：无重置点 → `now + quota_retry_s`（缺省 6h）。
- `pace(name, budgetLeft)`：Brave 距上次请求 <1050ms 则补齐等待（超预算剩余量则放弃该跳，记 `skipped:local_rate`）；DDG 礼貌间隔 2000ms；其余不等待。

---

## 5. Cache（src/cache.ts，~40 行，D9）

```ts
const store = new Map<string, { results: SearchResult[]; expiresAtMs: number }>();
```

- key：`sha1(normalizedQuery + '\0' + (freshness ?? '') + '\0' + sorted(includeDomains))`；normalizedQuery = trim + 小写 + 空白折叠（**仅用于 key，上游收原始查询**）。
- TTL：普通 3600s；`freshness=day` 900s。
- 容量：超 `max_entries`（缺省 512）逐最旧（Map 插入序 FIFO）。
- 命中：截断到请求 maxResults 直接返回（存储恒为 store_size 条 ≥ 请求上限，不存在存少取多）。
- 读写绕过：`use_cache=false` 或强制 provider。无负缓存、无 single-flight（D9）。

---

## 6. 归一化与去重（router/tools 内小函数，~30 行）

- URL 规范化（仅作 dedupe key，返回保留原 URL）：host 小写、去默认端口、去尾斜杠、剥追踪参数（`utm_*` 前缀 + `fbclid, gclid, msclkid, mc_eid, mc_cid, igshid, ref, spm` 显式集合）。
- 去重：同 key 保留 `(content ?? snippet ?? '').length` 更长者。MVP 单源胜出，只发生在同源内。

---

## 7. Provider Adapters — 五家映射表（字段级，2026-09-29 核对）

> 请求条数统一 `fetchCount = min(store_size=20, maxCount)`。

### 7.0 共享骨架（providers/types.ts）

```
fetch → 非 2xx：classify(status, headers, body) → throw ProviderError
      → 2xx：parse(body) → RawResult[]（空数组原样返回，Router 判 no_results）
fetch 抛 TimeoutError → ProviderError('timeout')；其它网络异常 → ProviderError('network')
通用兜底：未列出的 4xx → server_error 路径（detail= http_<code>，不增 failStreak）；5xx → server_error
```

### 7.1 博查 Bocha（priority 1）

`POST https://api.bochaai.com/v1/web-search`，`Authorization: Bearer $BOCHA_API_KEY`

| 我方参数 | 博查参数 | 说明 |
|---|---|---|
| query | `query` | 必填 |
| fetchCount | `count` | 1–50 |
| freshness | `freshness` | `day→oneDay, week→oneWeek, month→oneMonth, year→oneYear`；不传则缺省 `noLimit` |
| include_domains | — | 不支持，忽略并在 note 透出（v1.2.1） |
| content | `summary: true` | 网页长摘要 → content 字段 |

响应（Bing 兼容）`data.webPages.value[]`：`name→title, url→url, snippet→snippet, summary→content, siteName→siteName, dateLastCrawled（或 datePublished，实测取有者）→publishedDate`。无 score。

| 信号 | ErrorType | 动作参数 |
|---|---|---|
| 401（Invalid API KEY / 无接口调用权限） | `auth_failure` | ∞ |
| **403（"You do not have enough money"，余额不足）** | `quota_exhausted` | 余额制：`now + quota_retry_s`（6h） |
| 429（request limit） | `rate_limited` | 60s 缺省 |
| 400 / 5xx | `server_error` 路径 | detail `http_400` |

### 7.2 Tavily（priority 2）

`POST https://api.tavily.com/search`，`Authorization: Bearer $TAVILY_API_KEY`

| 我方参数 | Tavily 参数 | 说明 |
|---|---|---|
| query | `query` | |
| fetchCount | `max_results` | 上限 20 |
| freshness | `time_range` | 枚举同名直译（day/week/month/year） |
| include_domains | `include_domains` | 原生直传（v1.2.1） |
| 固定 | `search_depth: "basic"` | 1 credit/次（advanced 2，不用） |
| 固定 | `include_published_date: true` | beta，可能 null |

响应 `results[]`：`title, url, content（前 300 字→snippet，全文→content）, score, published_date→publishedDate`。

| 信号 | ErrorType | 动作参数 |
|---|---|---|
| 401 | `auth_failure` | ∞ |
| 429 + `Retry-After` 头 | `rate_limited` | 读头，缺省 60s |
| **432（Key/Plan limit）/ 433（PayGo limit）** | `quota_exhausted` | `nextReset(reset_day)`（注册周年日，配置填实际日期） |
| 422/400 | `server_error` 路径 | detail 带 code |
| 5xx | `server_error` | |

### 7.3 Brave（priority 3）

`GET https://api.search.brave.com/res/v1/web/search`，`X-Subscription-Token`，`Accept: application/json`

| 我方参数 | Brave 参数 | 说明 |
|---|---|---|
| query | `q` | |
| fetchCount | `count` | 上限 20 |
| freshness | `freshness` | `day→pd, week→pw, month→pm, year→py` |
| include_domains（恰好 1 个） | 拼进 `q`：`site:example.com {query}` | Brave 无域名过滤参数，单域名用 operator 实现（v1.2.1） |
| include_domains（多个） | 降级忽略 | 多域名 operator 语义不可靠，note 透出 |

响应 `web.results[]`：`title, url, description→snippet, page_age（ISO，若有）→publishedDate；age（"2 days ago"）page_age 缺席时尽力解析，失败留空`。无 score。

| 信号 | ErrorType | 动作参数 |
|---|---|---|
| **422 + `error.code=SUBSCRIPTION_TOKEN_INVALID`** | `auth_failure` | ∞（auth 信号是 422 不是 401） |
| 422 + `VALIDATION` | `server_error` 路径 | detail 带 code |
| 429 + `RATE_LIMITED` | `rate_limited` | `X-RateLimit-Reset` 第一桶秒数，缺省 60s |
| **429 + `QUOTA_LIMITED`** | `quota_exhausted` | `resetAtMs = now + X-RateLimit-Reset 第二桶秒数`（月配额真实重置点，比日历推算准） |
| 400（OPTION_NOT_IN_PLAN）/ 5xx | `server_error` 路径 | |

### 7.4 Exa（priority 4，一次性 credit 省着用）

`POST https://api.exa.ai/search`，`Authorization: Bearer $EXA_API_KEY`

| 我方参数 | Exa 参数 | 说明 |
|---|---|---|
| query | `query` | |
| fetchCount | `numResults` | 1–100 |
| freshness | `startPublishedDate` | `day→now-24h, week→-7d, month→-30d, year→-365d` 的 ISO 8601（发布时间过滤） |
| include_domains | `includeDomains` | 原生直传（v1.2.1） |
| 固定 | `type: "fast"` | 低延迟档（auto/deep 更贵） |
| 固定 | `contents: {text: {maxCharacters: 2000}}` | 拿正文但限长控成本 |

响应 `results[]`：`title, url, publishedDate→publishedDate, text→content`；score 当前文档未列，存在则透传。

| 信号 | ErrorType | 动作参数 |
|---|---|---|
| 401 | `auth_failure` | ∞ |
| **402（out of credits）** | `quota_exhausted` | 一次性 credit 无重置点 → `now + quota_retry_s`（6h） |
| 429 | `rate_limited` | 60s 缺省 |
| 400 / 503 | `server_error` 路径 | |

### 7.5 DuckDuckGo（priority 5，兜底，无 key）

`POST https://html.duckduckgo.com/html/`，form 编码：`q`；`df=d/w/m/y`（freshness）；浏览器 UA + Accept-Language。include_domains 不支持，忽略并 note 透出。

**关键陷阱：DDG 限流不是 429，是 HTTP 202 + 异常页；封禁是 403/challenge 页。解析前必须先做 bot-check 检测，否则 challenge 页被解析成 0 条，误触发 no_results 连环切源。**

处理顺序：① HTML 含 `anomaly`/`challenge`/captcha 特征 → `rate_limited`（detail `ddg_challenge`，冷却走该源 6h 覆盖）；② HTTP 202 → `rate_limited`（60s）；③ HTTP 403 → 同①；④ 其余非 200 → 通用兜底；⑤ 200 → 四层正则解析（每层非空即停）：A `a.result__a` 直接 URL / B `uddg=` 重定向解包 / C `.result` 块 + `.result__snippet` / D `h2` 内 http(s) 锚点兜底。锚文本→title、snippet；无 score/publishedDate。配额 `unbounded`；本地礼貌间隔 2000ms。

---

## 8. MCP 工具层（src/tools/）

- `search`：zod 入参 **6 个**（v1.2.1）——query 必填 min(1)、max_results int 1–20 缺省 8、freshness enum、include_domains string[]、provider string、use_cache bool 缺省 true。query > 400 字符截断并在 note 说明。编排：缓存查 → miss 则 `runSearch` → 成功写缓存（存完整 store_size 条，返回时截断到 max_results）。
- 返回统一规则：`content` 每条截断 **2000 字符**（控 token，业内惯例 tldw 4000 / Exa 2000）；`snippet` 缺失时由 content 前 **300 字符**兜底（Tavily/Exa/博查的 content 都走此规则）。
- 工具描述（给 agent 读）明确写入：content/publishedDate/score 为可选字段可能缺失、publishedDate 尽力而为、严格时间过滤用 freshness、include_domains 各源支持度。
- `status`：聚合 state/cache 快照，state 为 active / blocked(reason, 剩余) / disabled(auth_failure) / unconfigured。
- 错误边界：zod 失败由 SDK 返回 InvalidParams；空结果正常返回；内部异常捕获为 `internal_error` 结构化返回，进程不崩。

---

## 9. 配置（src/config.ts）

- 查找：`$SEARCH_FAILOVER_CONFIG` → cwd `search-failover.json` → 全默认。key 走 env：`BOCHA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY`。
- zod schema 与 mvp-spec §10 v1.2 JSON 一一对应；全字段带缺省——**零配置零 key 也能起服**（DDG 不需要 key，其余标 `unconfigured`）。
- 校验失败：stderr 报错 + `exit(1)`（唯一允许退出的场景）。

---

## 10. 测试方案

### 10.1 单元（test/unit/）

| 模块 | 核心用例 |
|---|---|
| state | 六类错误各自 blockedUntil；阶梯翻倍与封顶；quota 不走阶梯；auth=∞；成功清零；Brave pace 补齐与超预算放弃；reset_day=15 窗口归属；90% 预警 |
| cache | key 归一化（大小写/空白等价命中）；两档 TTL；FIFO 逐出；截断语义 |
| normalize | 追踪参数剥离；同 key 保留信息更全者 |

### 10.2 契约测试（msw 表驱动）——每家一张场景表

| 场景 | 博查 | Tavily | Brave | Exa | DDG |
|---|---|---|---|---|---|
| 正常 | 200 Bing 体 | 200 results | 200 web.results | 200 results | 200 html |
| 空结果 | `value: []` | `results: []` | `results: []` | `results: []` | 无 result__a 的页 |
| 限速 | 429 | 429 + `Retry-After` | 429 + `RATE_LIMITED` + 双桶头 | 429 | **202 异常页** |
| 配额 | **403 余额体** | **432** | **429 + `QUOTA_LIMITED` + 第二桶** | **402** | — |
| 鉴权 | 401 | 401 | **422 + `SUBSCRIPTION_TOKEN_INVALID`** | 401 | — |
| 服务端 | 500 | 500 | 500 | 503 | 500 |
| 超时 | msw delay | 同 | 同 | 同 | 同 |
| 未识别 4xx | — | 422 | 422 `VALIDATION` | 400 | — |
| 封禁 | — | — | — | — | **403 + challenge 页** |

加粗 = 每家最易写错的分类点（尤其博查 403→quota、Brave 422→auth）。

### 10.3 Router 集成（FakeProvider 场景表 → 验收映射）

| 场景 | 断言 | 验收 |
|---|---|---|
| 首选 429 → 次选成功 | 链含 `rate_limited`；屏蔽期内二次调用该源 `skipped` | #2 |
| 配额信号 → 屏蔽到 resetAt | status 可见 | #3 |
| 401 → ∞ 屏蔽 | 不再路由，status 标红 | #4 |
| 首家 0 条 → 切换 | `fail_streak` 不增、无屏蔽 | #5 |
| timeout 直接切换、无二次同源请求 | 每源恰好 1 次调用 | #6 |
| 缓存命中 | 二次调用上游 0 次；freshness=day 短 TTL | #7 |
| 同源去重 | utm 变体 URL 仅一条 | #8 |
| 全源故障 | `results: []` + 结构化摘要，不抛错 | #10 |
| 预算调小 + 慢源 | `skipped:budget_exhausted`，未请求剩余源 | #13 |

### 10.4 stdio 端到端

`Client` + `StdioClientTransport` spawn `dist/index.js`：listTools、真实调 status、本地 mock 上游端口调 search；覆盖验收 #11、#12 与 stdout 纯净性守卫。

---

## 11. 编码顺序（✅ 已于 2026-09-29 完成，70 用例全绿）

1. ~~scaffold~~ ✓ 2. ~~types + providers/types~~ ✓ 3. ~~state + cache + normalize 单测~~ ✓ 4. ~~Router + FakeProvider 集成~~ ✓（验收 2/4/5/6/10/13 已绿）5. ~~五家 adapter + msw 契约测试~~ ✓ 6. ~~工具层 + stdio e2e~~ ✓（含 stdout 纯净性守卫与无 key 容错）7. 宿主接入配置见 README（验收 11/12 由 e2e 覆盖协议层，真实宿主接入由使用时验证）。

## 12. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| DDG HTML 变更（2019 以来至少 3 次） | 四层解析互相独立，单层失效不级联；challenge 误判已用 bot-check 前置检测阻断 |
| Tavily `published_date` beta 可能 null | 字段 optional |
| Brave `age` 相对时间 | 尽力解析，失败留空；`page_age` 优先 |
| 博查日期字段名未最终确认 | 两者都试，联调实测锁定 |
| 阶梯冷却无上限翻倍的极端行为 | 封顶 `cooldown_max_s`；成功即清零 |
| 未识别 4xx 掩盖我方 bug | detail 保留状态码与响应体前 200 字符进 stderr |

---

## 附录 A：v1.2 裁剪依据（2026-09-29，15 家同类调研）

| 项目 | 形态 | 失败处理 / 冷却 | 对我们的启发 |
|---|---|---|---|
| daedra（Rust，12★） | 9 后端顺序兜底 | "熔断"= 连续失败后 30s 冷却；分类重试仅瞬时错误 | 冷却即时间戳；重试是可选分歧 |
| reliable-web-search（TS） | 8 源 + 多 key | 六类错误与我们同构；先换 key 再换源；**全样本唯一 half-open** | 分类表方向正确；half-open 无必要 |
| mcp-omnisearch（343★） | Tavily/Brave/Exa/Kagi 统一面 | **无 failover**（issue #191 请求中） | 我们做的正是它的缺口 |
| pi-search-hub | 19 后端 | 默认"第一家成功即返回"；可选 RRF 合并 | D2 对齐主流 |
| taka499/mcp-web-search | 5 源 | 自动切换，一句话 | 最小实现的存在证明 |
| search-fusion-mcp（Python） | 7 引擎 | 优先级路由 + cooldown | cooldown 表述即全部 |
| openclaw 运行时 | provider 链 | 顺序循环 + 错误分类；屏蔽时间戳 5min/30min | "时间戳+计数器"的标准形态 |
| codebuddy | 混合 | status→冷却时长一张映射表 | 最简冷却实现 |
| mcp-web-search（DmitriyOT） | fallback/merge | 重试+熔断+在途去重+令牌桶+持久缓存 | 过度实现的天花板（唯一 single-flight） |
| LiteLLM Router（LLM 网关） | 多 deployment | 连续失败→冷却时间戳；生产 Redis 只为共享该时间戳 | 无状态机是生产级惯例 |
| OpenRouter（商业） | 级联 | 失败换下一家；故障源 30s 降队尾 | 错误分类文档与我们同构 |
| SearXNG | 元搜索 | 引擎间零 failover/健康跟踪 | 域名过滤类参数属元搜索，不进我们 MVP |
| open-webui（90k★） | 单引擎可配 | 无 failover/缓存/健康 | 大体量玩家的极简取向 |
| argus | 14 源平台 | 预算路由 + RRF + dashboard | 平台化天花板，非 MCP 形态参照 |
| local-deep-research | 多引擎 | 自适应退避 | 无状态机又一例 |

**结论**：顺序兜底 + 错误分类 + 时间戳冷却是业内共识（保留）；状态机/熔断/half-open/负缓存/single-flight/用量回填在同类中无先例或近零先例（裁剪，D6/D8/D9）。
