# search-failover

![npm](https://img.shields.io/npm/v/search-failover) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![tests](https://img.shields.io/badge/tests-108%20passing-2EA44F) ![license](https://img.shields.io/badge/license-MIT-blue)

搜索故障转移网关 MCP：对外只暴露一个 `search` 工具，内部池化 8 个搜索源——默认链为博查 → Tavily → Brave → Exa → DuckDuckGo，另有三家可选源（智谱 / 百度千帆 / Serper，配置文件显式开启），任一家限额、超时或空结果时自动切换下一家。你的 agent 从此不必关心"哪家搜索又没额度了"。

> [!TIP]
> 一个 API key 都不配也能跑：DuckDuckGo 不需要 key，永远垫底兜底。



## 快速开始

无需安装，直接 `npx` 就能跑（也可以 `npm install -g search-failover`）；从源码跑则 `git clone` 后 `npm install && npm run build`。

API key 放环境变量即可，配几个用几个，没配的源自动跳过：

```bash
# —— 默认链（配 key 即自动加入）——
export BOCHA_API_KEY=...    # 可选，中文搜索最强
export TAVILY_API_KEY=...   # 可选，1000 次/月
export BRAVE_API_KEY=...    # 可选，2000 次/月
export EXA_API_KEY=...      # 可选，一次性 $10 credit，默认排第 4 省着用

# —— 可选链（付费/一次性额度源：配置文件显式开启后才进链，见下节）——
export ZHIPU_API_KEY=...       # 智谱 web_search，¥0.01/次（GLM Coding Plan 含次数）
export QIANFAN_API_KEY=...     # 百度千帆 ai_search，1500 次/月免费（超额按量）
export SERPER_API_KEY=...      # Serper.dev（Google 结果），一次性 2500 次
```

### 启用可选源（opt-in）

付费 / 一次性额度的源默认**不进链**（防止配了 key 被动消耗），需要在配置文件里显式开启。注意：配置文件一旦写了 `providers` 字段就**整体替换**默认链，示例里把存量五家一起带上：

```json
{
  "providers": [
    { "name": "bocha",   "enabled": true, "priority": 1 },
    { "name": "zhipu",   "enabled": true, "priority": 2, "quota": { "type": "one_time" } },
    { "name": "tavily",  "enabled": true, "priority": 3 },
    { "name": "qianfan", "enabled": true, "priority": 4, "quota": { "type": "monthly", "limit": 1500, "reset_day": 1 } },
    { "name": "brave",   "enabled": true, "priority": 5 },
    { "name": "serper",  "enabled": true, "priority": 6 },
    { "name": "exa",     "enabled": true, "priority": 7 },
    { "name": "duckduckgo", "enabled": true, "priority": 8 }
  ]
}
```

存为宿主 cwd 的 `search-failover.json`（或用 `SEARCH_FAILOVER_CONFIG` 指定路径）。全开后链为：博查 → 智谱 → Tavily → 百度 → Brave → Serper → Exa → DDG。



## 接入 MCP 宿主

ZCode / Claude Code / Cursor 等：

```json
{
  "mcpServers": {
    "search-failover": {
      "command": "npx",
      "args": ["-y", "search-failover"],
      "env": {
        "BOCHA_API_KEY": "...",
        "TAVILY_API_KEY": "..."
      }
    }
  }
}
```

也可以全局安装后直接指向二进制：`"command": "search-failover"`。从源码跑则用 `"command": "node"` + `args` 指向 `dist/index.js` 的绝对路径。

> [!NOTE]
> 可选配置文件 `search-failover.json`（放宿主 cwd，或用 `SEARCH_FAILOVER_CONFIG` 指定路径）：provider 优先级、月度配额与重置日、缓存 TTL、总预算。全字段有默认值，不写就按内置默认配置跑。



## 工具

`search` — 6 个参数：


| 参数                | 默认   | 说明                                                             |
| ----------------- | ---- | ----------------------------------------------------------------- |
| `query`           | 必填   | 搜索词（网关截 400 字符；智谱/百度有更严的源级截断，见 note）                    |
| `max_results`     | 8    | 1–20                                                              |
| `freshness`       | –    | `day / week / month / year`                                       |
| `include_domains` | –    | 仅返回这些域名的结果（Tavily/Exa/百度 原生支持，Brave/智谱/Serper 支持单域名，博查/DDG 忽略该参数） |
| `provider`        | –    | 强制指定单一源（调试用）                                                   |
| `use_cache`       | true | 同参数 1 小时内秒回                                                      |


返回 `results[]`（title/url/snippet 必有）+ `meta`（`provider_used`、完整 `fallback_chain`、`cache_hit`、`note`）。全部源耗尽时返回空数组 + 决策链，**不报错**——"全网都没搜到"本身是有信息量的答案。

`status` — 各源屏蔽状态与剩余时长、失败阶梯、配额用量与 90% 预警、缓存命中统计。

## 核心行为

- **顺序兜底**：博查 → Tavily → Brave → Exa → DDG（可选源开启后穿插其中），第一家非空即胜出；任何错误不做同源重试，**failover 即重试**。
- **六类错误分类**：每家 adapter 把真实信号映射为 `rate_limited / quota_exhausted / auth_failure / timeout / server_error / no_results`（如博查 403=余额不足、Brave 429 体区分秒级限速与月配额、智谱 429+1113=欠费、Serper 402=credit 耗尽、DDG 202 异常页=限流）。
- **阶梯冷却**：每源一个 `{blockedUntil, reason, failStreak}`，重复失败翻倍封顶，到点自然放行。无状态机、无熔断器。
- **配额软闸门**：本地计数达到配置的 `limit` 时该源记 `skipped:quota_local` 直接跳过（不再发请求）；权威停发仍是上游配额类错误。计数口径为"收到响应即计数"（空结果多数源仍计费），进程内有效、不落盘。
- **总预算 30s**：预算耗尽剩余源记 `skipped:budget_exhausted` 后立即返回，agent 永不挂死。
- **opt-in 防误耗**：付费/一次性额度源（智谱/百度/Serper）默认不进链，须配置文件显式开启。

## 开发

```bash
npm run dev         # tsx 本地起服
npm test            # 108 用例：单元 / 契约 / Router 集成 / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # 产出 dist/
```

新源接入流程（probe-first，D16）：先 `npx tsx scripts/probe.mts <provider>` 用真实 key 采集响应/错误体快照到 `test/fixtures/`，再据快照校准 adapter 契约测试——禁止凭文档手写 fixture。

日志走 stderr（`LOG=error|warn|info|debug`），stdout 永远只有 MCP 协议帧。



