# search-failover

![npm](https://img.shields.io/npm/v/search-failover) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![tests](https://img.shields.io/badge/tests-70%20passing-2EA44F) ![license](https://img.shields.io/badge/license-MIT-blue)

搜索故障转移网关 MCP：对外只暴露一个 `search` 工具，内部池化博查 / Tavily / Brave / Exa / DuckDuckGo 五个搜索源——任一家限额、超时或空结果时自动切换下一家。你的 agent 从此不必关心"哪家搜索又没额度了"。

> [!TIP]
> 一个 API key 都不配也能跑：DuckDuckGo 不需要 key，永远垫底兜底。



## 快速开始

无需安装，直接 `npx` 就能跑（也可以 `npm install -g search-failover`）；从源码跑则 `git clone` 后 `npm install && npm run build`。

API key 放环境变量即可，配几个用几个，没配的源自动跳过：

```bash
export BOCHA_API_KEY=...    # 可选，中文搜索最强
export TAVILY_API_KEY=...   # 可选，1000 次/月
export BRAVE_API_KEY=...    # 可选，2000 次/月
export EXA_API_KEY=...      # 可选，一次性 $10 credit，默认排第 4 省着用
```



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
| ----------------- | ---- | -------------------------------------------------------------- |
| `query`           | 必填   | 搜索词                                                            |
| `max_results`     | 8    | 1–20                                                           |
| `freshness`       | –    | `day / week / month / year`                                    |
| `include_domains` | –    | 仅返回这些域名（Tavily/Exa 原生支持，Brave 单域名 `site:`，博查/DDG 忽略并在 note 说明） |
| `provider`        | –    | 强制指定单一源（调试用）                                                   |
| `use_cache`       | true | 同参数 1 小时内秒回                                                    |


返回 `results[]`（title/url/snippet 必有）+ `meta`（`provider_used`、完整 `fallback_chain`、`cache_hit`、`note`）。全部源耗尽时返回空数组 + 决策链，**不报错**——"全网都没搜到"本身是有信息量的答案。

`status` — 各源屏蔽状态与剩余时长、失败阶梯、配额用量与 90% 预警、缓存命中统计。

## 核心行为

- **顺序兜底**：博查 → Tavily → Brave → Exa → DDG，第一家非空即胜出；任何错误不做同源重试，**failover 即重试**。
- **六类错误分类**：每家 adapter 把真实信号映射为 `rate_limited / quota_exhausted / auth_failure / timeout / server_error / no_results`（如博查 403=余额不足、Brave 429 体区分秒级限速与月配额、Exa 402=credit 耗尽、DDG 202 异常页=限流）。
- **阶梯冷却**：每源一个 `{blockedUntil, reason, failStreak}`，重复失败翻倍封顶，到点自然放行。无状态机、无熔断器。
- **总预算 30s**：预算耗尽剩余源记 `skipped:budget_exhausted` 后立即返回，agent 永不挂死。



## 开发

```bash
npm run dev         # tsx 本地起服
npm test            # 70 用例：单元 / 五家 msw 契约 / Router 集成 / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # 产出 dist/
```

日志走 stderr（`LOG=error|warn|info|debug`），stdout 永远只有 MCP 协议帧。



