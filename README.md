# search-failover

[简体中文](README.md) | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/search-failover)](https://www.npmjs.com/package/search-failover) [![CI](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

**一个 `search` 工具，背后 8 家搜索 API。** 哪家额度用完、被限流、超时或没有结果，自动换下一家。

[快速开始](#快速开始) · [搜索源](#搜索源) · [工作方式](#工作方式) · [接入宿主](#接入宿主) · [配置](#配置) · [工具与返回值](#工具与返回值) · [局限](#状态与局限)

## 为什么需要它

Agent 的搜索工具只接一家 API 时，那一家的月度额度用完、被限流，或者网络抖一下，这次搜索就失败了。更麻烦的是，如果工具把失败吞掉，只返回一个空数组，Agent 会以为网上没有相关信息，转头用训练数据作答，语气还很笃定。

search-failover 把多家搜索 API 放在同一个 `search` 工具后面，按优先级依次尝试，第一家返回结果就结束。每一步的成败都写进返回值，Agent 能看到这次搜索走过哪几家、跳过了哪几家、为什么。

## 一次返回长什么样

博查余额用完、Tavily 被限流、Brave 给出结果的一次搜索（上游响应是模拟的，用来展示返回结构）：

```jsonc
// search({ "query": "mcp stdio transport" })
{
  "results": [
    {
      "title": "Example: stdio transport",
      "url": "https://example.com/mcp/transports",
      "snippet": "Clients launch the server as a subprocess and talk JSON-RPC over stdin/stdout.",
      "publishedDate": "2026-09-18T00:00:00",
      "provider": "brave"
    }
    // …其余结果省略
  ],
  "meta": {
    "provider_used": "brave",
    "fallback_chain": [
      { "provider": "bocha", "outcome": "quota_exhausted", "detail": "http_403 You do not have enough money", "elapsedMs": 13 },
      { "provider": "tavily", "outcome": "rate_limited", "detail": "http_429", "elapsedMs": 0 }
    ],
    "cache_hit": false,
    "elapsed_ms": 14
  }
}
```

`fallback_chain` 记录了落空的每一家：博查返回 403（余额不足），记为 `quota_exhausted`，之后一段时间不再请求它；Tavily 返回 429，记为 `rate_limited`，冷却后才会再试；Brave 给出结果，搜索结束。

结果为空时也看这条链。链里全是正常的 `no_results`，才是真的没搜到；只要有一家报错或被跳过，MCP 就返回 `isError: true`，表示这次搜索没有完成。

## 特点

- **自动兜底。** 默认链是博查 → Tavily → Brave → Exa → DuckDuckGo，打开可选源后一共 8 家。第一家返回非空结果就结束；失败不在同一家重试，直接换下一家。
- **按各家的真实信号分类。** 博查的 403 是余额不足，Brave 的 key 无效是 422（不是 401），同一个 429 可能是秒级限流也可能是月额度用完，DuckDuckGo 限流时返回 202 加一个异常页。每家 adapter 单独适配，归成 8 类错误，每类有各自的冷却策略。
- **返回值是写给模型看的。** 带完整的决策链；“没搜到”和“没搜成”用 MCP 的 `isError` 区分；来源不支持的参数（比如博查不支持 `include_domains`）会在 `note` 里说明，不会悄悄忽略。插件还附带一份 Skill，教模型怎么读这条链。
- **不乱花钱。** 智谱、千帆、Serper 这类付费或一次性额度的来源，只配 key 不会进链，必须在配置里显式打开。多数来源带本地请求预算和限速，并发请求下也不会超发。
- **零配置能跑。** 不配任何 key 会走 DuckDuckGo；`npx` 直接启动；Codex 和 ZCode 可以从插件市场安装。
- **小，而且可审计。** 运行时依赖只有三个（MCP SDK、zod、htmlparser2）；没有数据库，没有后台任务，状态只放在进程内存里；日志全部走 stderr，stdout 只有协议帧。

## 快速开始

需要 Node ≥ 20.10，不用安装，`npx` 直接跑。

**1. 准备 API key。** 配几个用几个；一个都不配也能跑，只是只有 DuckDuckGo 可用。

```bash
export BOCHA_API_KEY=...    # 擅长中文搜索
export TAVILY_API_KEY=...   # 每月 1000 次
export BRAVE_API_KEY=...
export EXA_API_KEY=...
```

其余来源见[搜索源](#搜索源)。

**2. 接入宿主。** 以 Codex 为例：

```bash
codex mcp add search-failover -- npx -y search-failover
```

Cursor、ZCode、OpenCode、Claude Desktop 等见[接入宿主](#接入宿主)。

**3. 确认状态。** 让 Agent 调用一次 `status`，每家来源是 `active`、`unconfigured`（进程里没读到 key）还是 `blocked`，一目了然。

## 搜索源

| 来源 | 环境变量 | 优先级 | 默认进链 | 额度与计费 | `include_domains` |
| --- | --- | --- | --- | --- | --- |
| 博查 Bocha | `BOCHA_API_KEY` | 1 | 是 | 本地预算 1000 次/月 | 不支持 |
| 智谱 Zhipu | `ZHIPU_API_KEY` | 2 | 否 | ¥0.01/次（GLM Coding Plan 含次数） | 单域名 |
| Tavily | `TAVILY_API_KEY` | 3 | 是 | 1000 次/月 | 原生 |
| 百度千帆 | `QIANFAN_API_KEY` | 4 | 否 | 1500 次/月免费，超额按量 | 原生 |
| Brave | `BRAVE_API_KEY` | 5 | 是 | 本地参考预算 1000 次/月 | 单域名 |
| Serper | `SERPER_API_KEY` | 6 | 否 | 一次性 credits；本地一次性预算 2500 次 | 单域名 |
| Exa | `EXA_API_KEY` | 7 | 是 | 月度 credits；本地预算 800 次 | 原生 |
| DuckDuckGo | 无 | 8 | 是 | 免 key，受网络和反爬限制 | 不支持 |

- 默认链是博查 → Tavily → Brave → Exa → DuckDuckGo。“默认进链”为“否”的三家是付费或一次性额度，**只配 key 不会进链**，必须在配置文件里写 `enabled: true`（见[配置](#配置)）。全部打开后，顺序就是表里的优先级。
- “本地预算”是网关自己的保守计数，用来少发请求，不是账户余额，也不保证落在免费额度内。价格依据（2026-10-04）：[Brave](https://api-dashboard.search.brave.com/documentation/pricing) 的 1000 是月度 credits 折算出的参考值；[Exa](https://exa.ai/pricing) 按月重置 credits，800 只是保留的本地上限；Serper 分档计费尚待实测，本地不按推测的倍数扣费。
- 不支持 `include_domains`（或不支持多个域名）的来源照常搜索，同时在 `meta.note` 里写明已忽略。

## 工作方式

```text
search(query)
 ├─ 命中缓存       → 直接返回，不请求上游
 └─ 未命中 → 按优先级依次尝试；冷却中、本地预算用完、限速等不到的来源直接跳过
      Bocha    403 余额不足   → 屏蔽到恢复时间，换下一家
      Tavily   429 限流       → 冷却，换下一家
      Brave    返回结果       → 结束，返回结果和 fallback_chain
      Exa / DuckDuckGo …      （没轮到，不会被请求）
```

第一家非空结果胜出。任何错误都不在同一家重试，**换下一家就是重试**。每个来源只记三样东西：屏蔽到什么时候、为什么屏蔽、连续失败了几次；到点自动放行，放行后的第一个请求就是试探。没有状态机，也没有熔断器。

不同错误的处理：

| 类别 | 典型信号 | 处理 |
| --- | --- | --- |
| `rate_limited` | 429；DuckDuckGo 的异常页 | 按上游给的等待时间冷却，没有就 60 秒，上限 1 小时（DuckDuckGo 是 6 小时） |
| `quota_exhausted` | 博查 403；Exa、Serper 402；Tavily 432/433；Brave 429 + `QUOTA_LIMITED`；智谱 429 + 1113 | 屏蔽到上游给的恢复时间；没有就等 `quota_retry_s`（默认 6 小时） |
| `auth_failure` | 401；Brave 422 + `SUBSCRIPTION_TOKEN_INVALID` | 摘除该来源，直到重启 |
| `timeout` / `network` | 请求超时、连接失败 | 冷却 30 秒起，连续失败翻倍，上限 1 小时 |
| `server_error` | 5xx；响应无法解析 | 冷却 60 秒起，连续失败翻倍，上限 1 小时 |
| `request_error` | 400/422 等参数错误 | 不屏蔽该来源，换下一家 |
| `no_results` | 合法的空结果 | 不惩罚，换下一家 |

- **总预算。** 整次搜索最多 30 秒，单个来源最多 10 秒。预算用完记 `skipped:budget_exhausted`，不算来源的错，也不保证每家都被试到。宿主取消请求时，进行中的请求会中止，不再继续兜底。
- **两套时间互不干扰。** 上游给了恢复时间就用它，没有就等 `quota_retry_s`；本地 `reset_day` 只管本地计数，从不用来推算上游什么时候恢复。冷却结束只表示下一次搜索可以再试，网关不会在后台探测；这次尝试仍要先通过本地预算检查。
- **本地请求预算。** 每次批准向上游发请求就计一次：上游报错、批准后被取消也算；缓存命中、排队时被取消不算。计数达到 `quota.limit`，该来源这次记为 `skipped:quota_local`，不再发请求。`monthly` 按本地时区和 `reset_day` 重置，`one_time` 随进程累计。检查和计数在同一个同步步骤里完成，并发请求不会超发。

<details>
<summary>缓存与取数</summary>

- 缓存 key 由归一化的查询（忽略大小写和多余空白）、`max_results`、`freshness`、`include_domains` 组成。默认 TTL 1 小时，`freshness=day` 为 15 分钟，可用 `cache.ttl_s` / `cache.ttl_fresh_s` 调整。
- 指定 `provider`、`use_cache=false` 或全局关闭缓存时，不读也不写。缓存命中会保留获胜来源的降级说明。
- 每家按 `min(max_results, 来源条数上限)` 取数，不预取。不同条数分别缓存，非空的短结果也会缓存，不会为了凑够条数追加请求。
- `freshness` 由各家自己执行，日期语义和粒度可能不同；千帆会忽略 `day`，并在 `note` 里说明。

</details>

## 接入宿主

| 宿主 | 方式 |
| --- | --- |
| Codex | 插件市场，或 `codex mcp add` |
| ZCode | 插件市场，或手写 MCP 配置 |
| Cursor | MCP 配置（官方插件市场仍在审核） |
| OpenCode | MCP 配置（依官方文档编写，尚未在客户端实测） |
| Claude Desktop、Claude Code 等 | 通用 `mcpServers` 配置 |

本仓库按 [Agent Plugins 1.0](https://agent-plugins.org) 打包（见 `plugin/`），Codex / Cursor / ZCode 的市场清单放在仓库根目录。

> [!IMPORTANT]
> **密钥和可选源是两件事：**
> - API key 一律走**宿主进程的环境变量**（变量名见[搜索源](#搜索源)）。启动宿主前 `export`，或写进宿主配置的 `env` 字段。
> - **配了 key 不等于进链。** 智谱、千帆、Serper 必须在 `search-failover.json` 里显式 `enabled: true`；只配 key 不改配置，它们在 `status` 里显示为 `disabled`。
> - 插件形态下进程的 cwd 是插件缓存目录，`SEARCH_FAILOVER_CONFIG` 请用**绝对路径**。

<details>
<summary>Codex</summary>

**插件市场**（CLI ≥ 0.117）：

```bash
codex plugin marketplace add crisweb1994/search-failover
```

然后在 ChatGPT 桌面端 / Codex 的插件目录里安装 search-failover。本地开发可以直接加仓库路径：`codex plugin marketplace add ./search-failover`。

**MCP 配置**，一条命令：

```bash
codex mcp add search-failover -- npx -y search-failover
```

或者写 `~/.codex/config.toml`（项目级 `.codex/config.toml`）：

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # npx 首次冷启动可能超过默认的 10s

[mcp_servers.search-failover.env]
BOCHA_API_KEY = "..."
TAVILY_API_KEY = "..."
```

</details>

<details>
<summary>ZCode</summary>

**插件市场**：「发现」→ `+` → 粘贴 `https://github.com/crisweb1994/search-failover`（或本地仓库路径）→ 安装 search-failover。装完可以在插件详情的「配置」里填 `config_path`（search-failover.json 的绝对路径，可选，留空用内置默认）。

**MCP 配置**：用户级 `~/.zcode/cli/config.json`（项目级 `<repo>/.zcode/config.json`），注意是嵌套的 `mcp.servers`：

```json
{
  "mcp": {
    "servers": {
      "search-failover": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "search-failover"],
        "env": { "BOCHA_API_KEY": "..." },
        "timeoutMs": 60000
      }
    }
  }
}
```

ZCode 的 MCP schema 很严格：`command` 必须是字符串（不能写数组），环境变量字段必须叫 `env`，出现未知字段整条 server 会被静默丢弃；配置文件里不展开 `${...}` 模板，要写具体值。

</details>

<details>
<summary>Cursor</summary>

Cursor 同时支持 Agent Plugins 和 Cursor 原生插件两种格式，本仓库两种都带。官方市场的提交还在审核，在此之前用 MCP 配置，或者以本地目录方式添加仓库根目录的 `.cursor-plugin/marketplace.json`。

全局 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "search-failover": {
      "command": "npx",
      "args": ["-y", "search-failover"],
      "env": {
        "BOCHA_API_KEY": "${env:BOCHA_API_KEY}",
        "TAVILY_API_KEY": "${env:TAVILY_API_KEY}"
      }
    }
  }
}
```

`${env:NAME}` 是 Cursor 的变量插值，key 留在 shell 环境里，不进配置文件。不用的来源整行删掉。

</details>

<details>
<summary>OpenCode</summary>

没有插件市场清单，走 MCP 配置，`opencode.json`：

```jsonc
{
  "mcp": {
    "search-failover": {
      "type": "local",
      "command": ["npx", "-y", "search-failover"],
      "environment": { "BOCHA_API_KEY": "..." }
    }
  }
}
```

和其他宿主不同：`command` 是**数组**（命令和参数写在一起），环境变量字段叫 **`environment`**。这段依据 OpenCode 官方文档编写，尚未在客户端实测。

</details>

<details>
<summary>Claude Desktop、Claude Code 等</summary>

使用通用 `mcpServers` 格式的宿主：

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

全局安装（`npm install -g search-failover`）后可以直接指向二进制：`"command": "search-failover"`。从源码运行则用 `"command": "node"`，`args` 指向 `dist/index.js` 的绝对路径。

</details>

## 配置

不写配置文件也能跑。需要调整时，建一个 `search-failover.json`，查找顺序是：`SEARCH_FAILOVER_CONFIG` 指定的路径（必须存在且合法，否则启动失败）→ 宿主 cwd 下的同名文件 → 全默认。

打开可选源的例子。配置里一旦写了 `providers`，就**整体替换**默认链，所以示例把默认的五家也带上：

```json
{
  "providers": [
    { "name": "bocha" },
    { "name": "zhipu", "enabled": true },
    { "name": "tavily" },
    { "name": "qianfan", "enabled": true },
    { "name": "brave" },
    { "name": "serper", "enabled": true },
    { "name": "exa" },
    { "name": "duckduckgo" }
  ]
}
```

条目里省略的字段继承该来源的默认值（优先级、限速、额度、冷却）。可用字段如下：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `providers[].name` | 来源名：`bocha` `zhipu` `tavily` `qianfan` `brave` `serper` `exa` `duckduckgo` | 必填 |
| `providers[].enabled` | 是否进链 | 可选源 `false`，其余 `true` |
| `providers[].priority` | 顺序，数字小的先试 | 见[搜索源](#搜索源)的优先级 |
| `providers[].quota` | 本地请求预算：`type`（`monthly` / `one_time` / `unbounded`）、`limit`、`reset_day`（1–31） | 随来源，见[搜索源](#搜索源) |
| `providers[].quota_retry_s` | 上游配额错误没给恢复时间时的等待秒数，`0` 表示不施加这类冷却 | `21600` |
| `providers[].local_qps` / `min_interval_ms` | 本地限速 | Brave、千帆、Serper 默认 1 QPS，DuckDuckGo 间隔 2 秒 |
| `providers[].cooldown_max_s` | 覆盖该来源的冷却上限 | 全局值；DuckDuckGo 为 21600 |
| `defaults.timeout_ms` | 单个来源的请求超时 | `10000` |
| `defaults.total_budget_ms` | 整次搜索的总预算 | `30000` |
| `defaults.cooldown_default_s` / `cooldown_max_s` | 限流缺省冷却 / 冷却上限（秒） | `60` / `3600` |
| `cache.enabled` | 是否启用缓存 | `true` |
| `cache.ttl_s` / `ttl_fresh_s` | 缓存 TTL，后者用于 `freshness=day` | `3600` / `900` |
| `cache.max_entries` | 缓存条数上限 | `512` |

规则：

- `providers: []` 表示空链。
- 未知或重复的来源名、未知字段（包括拼错的字段名，比如把 `limit` 写成 `limt`）、非法数值，都会让启动失败，并指出出错的位置。
- `quota` 类型不变时按字段合并；切换类型则使用新配置，比如 `quota: { "type": "unbounded" }` 可以关掉本地额度限制。

<details>
<summary>从旧版本迁移</summary>

`quota` 现在只描述本地请求预算；上游配额错误的等待间隔是 provider 顶层的 `quota_retry_s`，比如 `{ "name": "bocha", "quota_retry_s": 600 }` 表示上游没给恢复时间时等 10 分钟，再由下一次搜索去试。

旧配置里的这些字段仍然可以写，并按原来的范围校验：

- `quota.quota_retry_s` 会提升到顶层；同时写了顶层值时，以顶层为准；非法的旧值仍然报错。
- `provider.fetch_policy` 和 `cache.store_size` 已被忽略，不再控制取数或缓存写入。

它们不会产生任何提示，配置文件也不会被改写；除此之外的未知字段一律视为错误。

行为上的变化：不同条数不再共用缓存，可能增加上游请求次数；旧 `store_size` 较小时，按需取数可能让单次返回变多；固定的恢复间隔会让仍然欠费的来源被定期尝试。实际费用取决于供应商的计费方式和你的使用情况，不承诺比以前更省。

</details>

## 工具与返回值

### `search`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `query` | 必填 | 搜索词。网关截断到 400 字符；智谱、千帆还有更严的来源级截断，会在 `note` 里说明 |
| `max_results` | 8 | 1–20 |
| `freshness` | – | `day` / `week` / `month` / `year` |
| `include_domains` | – | 只返回这些域名的结果，各来源的支持程度见[搜索源](#搜索源) |
| `provider` | – | 强制指定单一来源（调试用） |
| `use_cache` | true | 是否读写缓存 |

返回 `results[]` 和 `meta`。每条结果一定有 `title` 和 `url`；正文在 `content`（来源给出较长摘要时）或 `snippet`（只有短摘要时），两者不会同时出现，也可能都缺失。`meta` 里有 `provider_used`、完整的 `fallback_chain`、`cache_hit`、`elapsed_ms` 和可选的 `note`。

怎么读 `fallback_chain`：

| outcome | 含义 |
| --- | --- |
| `no_results` | 这一家正常返回了空结果 |
| `rate_limited` `quota_exhausted` `auth_failure` `timeout` `network` `server_error` `request_error` | 这一家失败了，处理方式见[工作方式](#工作方式) |
| `skipped:<原因>` | 这次没有请求这一家。原因可能是仍在冷却（`rate_limited` 等，`auth_failure` 的 detail 是 `until_restart`）、`quota_local`（本地预算用完）、`local_rate`（限速等不到）、`budget_exhausted`（总预算用完） |

空结果的判断：链非空且全是 `no_results`，是正常的空搜索；有任何失败或跳过，或者没有可用的来源，MCP 返回 `isError: true`。

### `status`

没有参数，返回每家来源的状态、屏蔽原因和剩余时间、连续失败次数、本地用量（达到 90% 预警）、缓存命中统计。节选：

```jsonc
{
  "providers": [
    { "name": "bocha", "state": "blocked(quota_exhausted, 剩21600s)", "used_requests": 1, "quota_profile": "monthly:1000@day1", "quota_warning": false },
    { "name": "tavily", "state": "blocked(rate_limited, 剩60s)", "used_requests": 1, "quota_profile": "monthly:1000@day2", "quota_warning": false },
    { "name": "brave", "state": "active", "used_requests": 1, "quota_profile": "monthly:1000@day15", "quota_warning": false },
    { "name": "zhipu", "state": "unconfigured", "used_requests": 0, "quota_profile": "one_time", "quota_warning": false }
    // …
  ],
  "cache": { "entries": 1, "hits": 0, "misses": 1 },
  "uptime_s": 0
}
```

`used_requests` 是本地批准的上游尝试数；`used_this_month` 是同值的兼容别名。

### 排错

| `status` 里看到 | 含义 | 怎么办 |
| --- | --- | --- |
| `unconfigured` | 进程里没读到这家的环境变量 | 检查宿主的 `env` 配置，改完重启宿主 |
| `disabled` | 配了 key，但这是可选源，配置里没写 `enabled: true` | 见[配置](#配置) |
| `disabled(auth_failure)` | key 被上游拒绝，已摘除到重启 | 换 key，重启宿主 |
| `blocked(<原因>, 剩Ns)` | 冷却中 | 等待，或看 `last_error` |
| `blocked(quota_local)` | 本地请求预算用完 | 调大 `quota.limit`，或等下个周期 |
| `active` | 可用 | – |

## 状态与局限

- **状态只在进程内存里。** 计数、限速、冷却和缓存重启即清零，不同宿主之间不共享，也不包含其他应用对同一个 key 的消耗。本地预算是保守的请求计数，不是账户余额。
- **相同查询并发时不合并请求。** 两个一模一样的请求同时到达，各请求一次上游。
- **不合并多家结果。** 第一家返回非空结果就结束；这是容灾网关，不是元搜索引擎。
- **三家可选源还没用真实 key 校准。** 智谱、千帆、Serper 的契约测试用的是按官方文档（或第三方口径）构造的响应，错误码对照也主要来自这些资料；千帆的真实接口仍待凭据验证。`scripts/probe.mts` 就是用来采集真实响应的，手上有 key 的话，欢迎跑一遍并把脱敏后的结果贴到 issue 里。
- **DuckDuckGo 靠抓取 HTML 页面。** 免 key，但受网络和反爬限制，页面改版可能失效；遇到不认识的页面结构会报错，不会当成空结果。
- **宿主兼容。** OpenCode 的配置依官方文档编写，尚未在客户端实测；Cursor 的官方插件市场仍在审核。

## 开发与发布

```bash
npm run dev         # tsx 本地起服
npm test            # 单元 / 契约 / Router 集成 / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # 产出 dist/
```

从源码运行：`git clone` 后 `npm install && npm run build`。日志走 stderr（`LOG=error|warn|info|debug`），stdout 只有 MCP 协议帧。

接入新来源的流程是 probe-first：先 `npx tsx scripts/probe.mts <provider>`，用真实 key 采集响应和错误体的脱敏快照到 `test/fixtures/`，再据此校准 adapter 的契约测试，不凭文档手写 fixture。目前智谱、千帆、Serper 还没走完这一步，见上面的局限。

插件清单校验与版本同步：`npm run plugin:check`（结构级校验，`prepublishOnly` 会跑）、`npm run plugin:sync`（把 `package.json` 的版本同步进 plugin manifest、市场清单和 npx 锁定版本）。

发布冒烟按插件同款命令拉起真实分发包，跑完 initialize → tools/list → status → 真实搜索的整套握手：`node scripts/smoke-stdio.mjs`，支持 `--env KEY=V`、`--config /绝对路径/search-failover.json`、`--command node -- dist/index.js`（本地构建）。

<details>
<summary>发布流程（npm + 插件清单同步）</summary>

市场清单里锁定的 npx 版本必须对应 npm 上已有的包，所以顺序是固定的：

```bash
npm version <x.y.z> --no-git-tag-version   # 1. 显式写目标版本，不要依赖 patch
npm run plugin:sync                         # 2. 同步 3 份 manifest、3 份市场清单、3 处 npx 锁定版本
npm run plugin:check && npm test            # 3. 校验（prepublishOnly 还会再跑一遍）
git add -A && git commit -m "release: <x.y.z>"   # 4. 版本号和清单必须进同一个 commit
# 5. 打 tag / 建 GitHub Release，由 CI 发布到 npm
```

从 Release 触发 CI 到 npm 发布完成，中间有几分钟窗口：市场清单已经指向新版本，npm 上还装不到。窗口期内不要对外公告插件更新。

</details>

## 反馈

遇到某家搜索 API 的异常行为，欢迎提 [issue](https://github.com/crisweb1994/search-failover/issues)，最好附上脱敏后的响应体，它可以直接变成一条契约测试。

## 许可证

[MIT](LICENSE)
