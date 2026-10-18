# search-failover

[简体中文](README.md) | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/search-failover)](https://www.npmjs.com/package/search-failover) [![CI](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

**一个 `web_search` 工具，背后 9 家搜索来源。** 哪家额度用完、被限流、超时或没有结果，自动换下一家。本地宿主走 stdio，远程平台走 Streamable HTTP；发布包是单个文件，没有运行时依赖。

[快速开始](#快速开始) · [搜索源](#搜索源) · [工作方式](#工作方式) · [接入宿主](#接入宿主) · [配置](#配置) · [网络与代理](#网络与代理) · [工具与返回值](#工具与返回值) · [局限](#状态与局限)

## 为什么需要它

Agent 的搜索工具只接一家 API 时，那一家的月度额度用完、被限流，或者网络抖一下，这次搜索就失败了。更麻烦的是，如果工具把失败吞掉，只返回一个空数组，Agent 会以为网上没有相关信息，转头用训练数据作答，语气还很笃定。

search-failover 把多家搜索 API 放在同一个 `web_search` 工具后面，按优先级依次尝试，第一家返回结果就结束。每一步的成败都写进返回值，Agent 能看到这次搜索走过哪几家、跳过了哪几家、为什么。

## 一次返回长什么样

博查余额用完、Tavily 被限流、Brave 给出结果的一次搜索（上游响应是模拟的；实际输出是紧凑 JSON，这里排过版）：

```jsonc
// web_search({ "query": "mcp stdio transport" })
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

结果为空时也看这条链。链里全是 `no_results`，才是真的没搜到；只要有一家报错或被跳过，MCP 就返回 `isError: true`，表示这次搜索没有完成。

## 特点

- **自动兜底。** 默认链是博查 → Tavily → Brave → Exa → SearXNG → DuckDuckGo，配了凭据的才会进链，DuckDuckGo 免 key 兜底。失败不在同一家重试，直接换下一家。
- **按各家的真实信号分类。** 博查的 403 是余额不足，Brave 的 key 无效是 422（不是 401），同一个 429 可能是秒级限流也可能是月额度用完，DuckDuckGo 限流时返回 202 加一个异常页。每家 adapter 单独适配，归成 8 类错误，每类有各自的冷却策略。
- **返回值是写给模型看的。** 带完整的决策链；"没搜到"和"没搜成"用 MCP 的 `isError` 区分；带 `include_domains` 时先试能过滤的来源，最终给出结果的来源做不到时在 `note` 里说明；工具描述只列出当前真正可用的来源。
- **一份配置，所有宿主共用。** 凭据和来源顺序可以全部用环境变量配置，也可以写进 `~/.config/search-failover/config.json`，每个宿主的配置只剩一行 `npx -y search-failover`。宿主没展开的 `${...}` 模板不会被当成 key。
- **本地和远程都能接。** stdio 给 Claude Code、Cursor、Codex 这类本地宿主；`--http` 启动 Streamable HTTP 服务，给只支持远程 MCP 的平台用，多个客户端共享同一份额度计数、冷却和缓存。
- **不乱花钱。** 智谱、千帆、Serper 这类付费或一次性额度的来源，只配 key 不会进链，必须显式列出。多数来源带本地请求预算和限速，并发请求下也不会超发。
- **能走代理。** 读取 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（Node 自带的 fetch 不读这些变量）。
- **小，而且可审计。** 发布包是 esbuild 打出的单个文件，`npx` 冷启动只下载一个包；没有数据库、没有后台任务，状态只在进程内存里；日志全部走 stderr。

## 快速开始

需要 Node ≥ 20.10，不用安装，`npx` 直接跑。

**1. 准备凭据。** 配几个用几个；一个都不配也能跑，只是只有 DuckDuckGo（国内网络需要代理，见[网络与代理](#网络与代理)）。推荐写进用户级配置文件，所有宿主共用：

```jsonc
// ~/.config/search-failover/config.json（Windows：%APPDATA%\search-failover\config.json）
{
  "credentials": {
    "BOCHA_API_KEY": "...",
    "TAVILY_API_KEY": "..."
  }
}
```

建议 `chmod 600` 这个文件。也可以照常用环境变量（变量名见[搜索源](#搜索源)），环境变量优先。

**2. 接入宿主。** 以 Claude Code 为例：

```bash
claude mcp add search-failover -- npx -y search-failover
```

Codex、Cursor、ZCode、VS Code、OpenCode、Claude Desktop 等见[接入宿主](#接入宿主)。

**3. 确认状态。** 让 Agent 调用一次 `web_search_status`：每家来源是 `active`、`unconfigured`（没读到凭据）、`disabled`（不在链里）还是 `blocked`，配置文件在哪、有没有错误，一目了然。

## 搜索源

<!-- generated:providers -->
| 来源 | 配置变量 | 默认进链 | 本地预算 | `include_domains` |
| --- | --- | --- | --- | --- |
| Bocha 博查 | `BOCHA_API_KEY` | 是 | 每月 1000 次，1 日重置 | 不支持 |
| Zhipu 智谱 | `ZHIPU_API_KEY` | 否（需显式列出） | 不限 | 单个域名 |
| Tavily | `TAVILY_API_KEY` | 是 | 每月 1000 次，2 日重置 | 多个域名 |
| Baidu Qianfan 百度千帆 | `QIANFAN_API_KEY` | 否（需显式列出） | 每月 1500 次，1 日重置 | 多个域名 |
| Brave Search | `BRAVE_API_KEY` | 是 | 每月 1000 次，15 日重置 | 单个域名 |
| Serper | `SERPER_API_KEY` | 否（需显式列出） | 累计 2500 次 | 单个域名 |
| Exa | `EXA_API_KEY` | 是 | 每月 800 次，1 日重置 | 多个域名 |
| SearXNG (self-hosted) | `SEARXNG_URL`（实例地址） | 是 | 不限 | 单个域名 |
| DuckDuckGo | 无需配置 | 是 | 不限 | 单个域名 |
<!-- /generated:providers -->

- 表格按默认优先级排列，由 `npm run plugin:sync` 从来源注册表生成。默认链只包含"默认进链"为"是"、且配好了凭据的来源。
- 智谱、千帆、Serper 是付费或一次性额度，**只配 key 不会进链**，要在 `SEARCH_FAILOVER_PROVIDERS` 或配置文件的 `providers` 里显式列出（见[配置](#配置)）。
- "本地预算"是网关自己的保守计数，用来少发请求，不是账户余额，也不保证落在免费额度内。价格依据（2026-10-04）：[Brave](https://api-dashboard.search.brave.com/documentation/pricing) 的 1000 是月度 credits 折算出的参考值；[Exa](https://exa.ai/pricing) 按月重置 credits，800 只是保留的本地上限；智谱按次计费（GLM Coding Plan 含次数）；千帆每月 1500 次免费，超额按量；Serper 是一次性 credits，分档计费尚待实测。
- SearXNG 需要自建实例，并在实例的 `settings.yml` 里把 `json` 加进 `search.formats`，否则接口返回 403。
- DuckDuckGo 靠抓取 HTML 页面，免 key 但受反爬限制；国内网络无法直连。

## 工作方式

```text
web_search(query)
 ├─ 命中缓存       → 直接返回，不请求上游
 └─ 未命中 → 按优先级依次尝试；冷却中、本地预算用完、限速等不到的来源直接跳过
      Bocha    403 余额不足   → 屏蔽到恢复时间，换下一家
      Tavily   429 限流       → 冷却，换下一家
      Brave    返回结果       → 结束，返回结果和 fallback_chain
      Exa / DuckDuckGo …      （没轮到，不会被请求）
```

第一家非空结果胜出。任何错误都不在同一家重试，**换下一家就是重试**。每个来源只记三样东西：屏蔽到什么时候、为什么屏蔽、连续失败了几次；到点自动放行，放行后的第一个请求就是试探。

带 `include_domains` 时，能执行这个过滤的来源排到前面（原生支持多域名的，或只有一个域名时支持单域名的），做不到的放到最后兜底。

不同错误的处理：

| 类别 | 典型信号 | 处理 |
| --- | --- | --- |
| `rate_limited` | 429；DuckDuckGo 的异常页 | 按上游给的等待时间冷却，没有就 60 秒，上限 1 小时（DuckDuckGo 是 6 小时） |
| `quota_exhausted` | 博查 403；Exa、Serper 402；Tavily 432/433；Brave 429 + `QUOTA_LIMITED`；智谱 429 + 1113 | 屏蔽到上游给的恢复时间；没有就等 `quota_retry_s`（默认 6 小时） |
| `auth_failure` | 401；Brave 422 + `SUBSCRIPTION_TOKEN_INVALID` | 摘除该来源，直到重启 |
| `timeout` / `network` | 请求超时、连接失败（`detail` 带上 ENOTFOUND、ECONNREFUSED、证书错误等真实原因） | 冷却 30 秒起，连续失败翻倍，上限 1 小时 |
| `server_error` | 5xx；响应无法解析；SearXNG 所有引擎都失败 | 冷却 60 秒起，连续失败翻倍，上限 1 小时 |
| `request_error` | 400/422 等参数错误 | 不屏蔽该来源，换下一家 |
| `no_results` | 合法的空结果（博查、Brave 没有结果时会省略结果字段，也按空结果处理） | 不惩罚，换下一家 |

- **总预算。** 整次搜索最多 30 秒，单个来源最多 10 秒。还没轮到的来源记 `skipped:budget_exhausted`；已经发出请求、总预算先用完的记 `budget_exhausted`。两者都不算来源的错。宿主取消请求时，进行中的请求会中止，不再继续兜底。
- **两套时间互不干扰。** 上游给了恢复时间就用它，没有就等 `quota_retry_s`；本地 `reset_day` 只管本地计数。冷却结束只表示下一次搜索可以再试，网关不会在后台探测。
- **本地请求预算。** 每次批准向上游发请求就计一次：上游报错、批准后被取消也算；缓存命中、排队时被取消不算。计数达到 `quota.limit`，该来源记为 `skipped:quota_local`。`monthly` 按本地时区和 `reset_day` 重置，`one_time` 随进程累计。检查和计数在同一个同步步骤里完成，并发请求不会超发。

<details>
<summary>缓存与取数</summary>

- 缓存 key 由归一化的查询（忽略大小写和多余空白）、`max_results`、`freshness`、`include_domains` 组成。默认 TTL 1 小时，`freshness=day` 为 15 分钟，可用 `cache.ttl_s` / `cache.ttl_fresh_s` 调整。
- `use_cache=false` 或全局关闭缓存时，不读也不写。缓存命中会重新给出获胜来源的降级说明。
- 每家按 `min(max_results, 来源条数上限)` 取数，不预取。不同条数分别缓存，非空的短结果也会缓存。
- `freshness` 由各家自己执行，日期语义和粒度可能不同；千帆会忽略 `day`，并在 `note` 里说明。

</details>

## 接入宿主

| 宿主 | 方式 |
| --- | --- |
| Claude Code | `claude mcp add`，或 `.mcp.json` |
| Codex | 插件市场，或 `codex mcp add` |
| Cursor | MCP 配置（官方插件市场仍在审核） |
| ZCode | 插件市场，或手写 MCP 配置 |
| VS Code（Copilot） | `.vscode/mcp.json` |
| OpenCode | MCP 配置（依官方文档编写，尚未在客户端实测） |
| Claude Desktop、Windsurf、Cline、Cherry Studio 等 | 通用 `mcpServers` 配置 |
| 只支持远程 MCP 的平台（网页版客户端、Dify / n8n 等工作流平台） | [HTTP 模式](#http-模式远程平台) |

本仓库按 [Agent Plugins 1.0](https://agent-plugins.org) 打包（见 `plugin/`），Codex / Cursor / ZCode 的市场清单放在仓库根目录。

> [!IMPORTANT]
> **各宿主通用的几件事：**
> - **凭据放哪都行，推荐用户级配置文件。** 环境变量优先，其次是 `~/.config/search-failover/config.json` 的 `credentials`。这样宿主配置里不用再写 key。
> - **从程序坞 / 开始菜单启动的 GUI 宿主（如 Claude Desktop）读不到 shell 里 `export` 的变量**，而且常常找不到用 nvm、Volta、fnm 装的 `npx`。遇到 `spawn npx ENOENT` 时，把 `command` 换成 `npx` 的绝对路径（`which npx` 查看），凭据写进配置文件。
> - **Windows** 上如果宿主报找不到 `npx`，把 `"command": "npx"` 改成 `"command": "cmd"`，`args` 前面加上 `"/c", "npx"`。
> - **只配 key 不等于进链。** 智谱、千帆、Serper 要在 `SEARCH_FAILOVER_PROVIDERS` 或配置文件的 `providers` 里列出。
> - 宿主没有展开的 `${...}` 模板会被当作未设置，并在 `web_search_status` 的 `config.warnings` 里提示。

<details>
<summary>Claude Code</summary>

```bash
claude mcp add search-failover -- npx -y search-failover
# 需要在宿主里单独给凭据或来源顺序时：
claude mcp add search-failover -e TAVILY_API_KEY=... -e SEARCH_FAILOVER_PROVIDERS=tavily,brave,duckduckgo -- npx -y search-failover
```

加 `--scope user` 对所有项目生效。连接 HTTP 模式：`claude mcp add --transport http search-failover http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"`。

</details>

<details>
<summary>Codex</summary>

**插件市场**（CLI ≥ 0.117）：

```bash
codex plugin marketplace add crisweb1994/search-failover
```

然后在 ChatGPT 桌面端 / Codex 的插件目录里安装 search-failover。凭据写进用户级配置文件即可。

**MCP 配置**：

```bash
codex mcp add search-failover -- npx -y search-failover
```

或者写 `~/.codex/config.toml`：

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # npx 首次下载可能超过默认的 10 秒

[mcp_servers.search-failover.env]
TAVILY_API_KEY = "..."
```

</details>

<details>
<summary>Cursor</summary>

全局 `~/.cursor/mcp.json` 或项目 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "search-failover": {
      "command": "npx",
      "args": ["-y", "search-failover"],
      "env": {
        "TAVILY_API_KEY": "${env:TAVILY_API_KEY}"
      }
    }
  }
}
```

`${env:NAME}` 是 Cursor 的变量插值，key 留在 shell 环境里。凭据都在用户级配置文件里时，`env` 整段可以删掉。仓库里也带了 Cursor 原生插件清单（`.cursor-plugin/`），官方市场审核通过前可以本地添加。

</details>

<details>
<summary>ZCode</summary>

**插件市场**：「发现」→ `+` → 粘贴 `https://github.com/crisweb1994/search-failover` → 安装。插件详情的「配置」里有两项，都可以留空：`config_path`（配置文件的绝对路径，默认读用户级文件）和 `providers`（来源顺序，如 `bocha,tavily,duckduckgo`）。凭据写进用户级配置文件。

**MCP 配置**：用户级 `~/.zcode/cli/config.json`（项目级 `<repo>/.zcode/config.json`），注意是嵌套的 `mcp.servers`：

```json
{
  "mcp": {
    "servers": {
      "search-failover": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "search-failover"],
        "timeoutMs": 60000
      }
    }
  }
}
```

ZCode 的 MCP schema 很严格：`command` 必须是字符串，环境变量字段必须叫 `env`，出现未知字段整条 server 会被静默丢弃；配置文件里不展开 `${...}` 模板。

</details>

<details>
<summary>VS Code（Copilot）</summary>

`.vscode/mcp.json`（注意顶层是 `servers`）：

```json
{
  "servers": {
    "search-failover": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "search-failover"]
    }
  }
}
```

</details>

<details>
<summary>OpenCode</summary>

`opencode.json`：

```jsonc
{
  "mcp": {
    "search-failover": {
      "type": "local",
      "command": ["npx", "-y", "search-failover"],
      "environment": { "TAVILY_API_KEY": "..." }
    }
  }
}
```

和其他宿主不同：`command` 是**数组**，环境变量字段叫 **`environment`**。这段依据 OpenCode 官方文档编写，尚未在客户端实测。

</details>

<details>
<summary>Claude Desktop、Windsurf、Cline、Cherry Studio 等</summary>

使用通用 `mcpServers` 格式的宿主：

```json
{
  "mcpServers": {
    "search-failover": {
      "command": "npx",
      "args": ["-y", "search-failover"]
    }
  }
}
```

全局安装（`npm install -g search-failover`）后可以直接写 `"command": "search-failover"`。从源码运行则用 `"command": "node"`，`args` 指向 `dist/index.js` 的绝对路径。

</details>

### HTTP 模式（远程平台）

```bash
SEARCH_FAILOVER_HTTP_TOKEN=$(openssl rand -hex 24) npx -y search-failover --http --port 8787
# MCP 端点：http://127.0.0.1:8787/mcp   健康检查：/healthz
```

- 无状态的 Streamable HTTP：每个请求独立处理，所有客户端共享同一份额度计数、冷却和缓存，多个宿主同时用也不会各算各的。
- 默认只监听 `127.0.0.1`。监听其他地址（`--host 0.0.0.0`）必须设置 `SEARCH_FAILOVER_HTTP_TOKEN`，否则拒绝启动；公网暴露请放在 HTTPS 反向代理后面。
- 客户端用 `Authorization: Bearer <token>` 鉴权。只能填一个 URL 的平台可以写成 `https://your.host/mcp?token=<token>`，但查询参数可能出现在代理日志里。
- 不设 token 时只接受本机的 Host / Origin，防止网页借 DNS rebinding 调用你的本地服务。

## 配置

不写配置也能跑。需要调整时有两种方式，可以混用：

**环境变量**（每个宿主都支持，适合简单场景）：

| 变量 | 作用 |
| --- | --- |
| `BOCHA_API_KEY` 等 | 各来源的凭据，见[搜索源](#搜索源) |
| `SEARCH_FAILOVER_PROVIDERS` | 运行链，按优先级逗号分隔，如 `tavily,brave,duckduckgo`；列出的可选源直接启用 |
| `SEARCH_FAILOVER_CONFIG` | 配置文件路径，默认用户级文件 |
| `SEARCH_FAILOVER_HTTP_TOKEN` | HTTP 模式的 token |
| `SEARCH_FAILOVER_DEBUG=1` | 给模型暴露调试参数 `provider`（强制只查一家） |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | 出站代理，见[网络与代理](#网络与代理) |
| `LOG` | 日志级别：`error` / `warn` / `info` / `debug`（写 stderr，`debug` 会记录每一步兜底） |

**配置文件**：先看 `SEARCH_FAILOVER_CONFIG`（指定了就必须存在且合法），否则读用户级文件 `$XDG_CONFIG_HOME/search-failover/config.json`，默认 `~/.config/search-failover/config.json`，Windows 为 `%APPDATA%\search-failover\config.json`。**不读当前目录**：宿主的工作目录各不相同，而且别人仓库里的配置文件不应该替你打开付费来源。

```json
{
  "credentials": {
    "TAVILY_API_KEY": "...",
    "ZHIPU_API_KEY": "...",
    "SEARXNG_URL": "http://localhost:8080"
  },
  "providers": [
    { "name": "zhipu" },
    { "name": "tavily" },
    { "name": "brave", "quota": { "limit": 500 } },
    { "name": "searxng" },
    { "name": "duckduckgo" }
  ]
}
```

规则：

- `providers` 的**数组顺序就是优先级**，列出即启用（`"enabled": false` 可以暂时停用）。不写 `providers` 用默认链，写 `[]` 就是空链。
- 设置了 `SEARCH_FAILOVER_PROVIDERS` 时，名单和顺序以它为准；配置文件里对应来源的调优字段仍然生效。
- `credentials` 的键是环境变量名；同名环境变量优先。
- 条目里省略的字段继承该来源的默认值（限速、额度、冷却）。`quota` 类型不变时按字段合并；切换类型则整体替换，比如 `{ "type": "unbounded" }` 关掉本地额度限制。
- 未知或重复的来源名、未知字段（包括拼错的字段名，比如把 `limit` 写成 `limt`）、非法数值都算配置错误。**出错时网关照常启动，但不运行任何来源**：每次搜索都返回 `config_error` 和出错位置，`web_search_status` 里也能看到，在任何宿主的对话里都能直接看到原因。

可用字段：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `providers[].name` | 来源名：`bocha` `zhipu` `tavily` `qianfan` `brave` `serper` `exa` `searxng` `duckduckgo` | 必填 |
| `providers[].enabled` | 设为 `false` 暂时停用 | `true` |
| `providers[].quota` | 本地请求预算：`type`（`monthly` / `one_time` / `unbounded`）、`limit`、`reset_day`（1–31） | 随来源，见[搜索源](#搜索源) |
| `providers[].quota_retry_s` | 上游配额错误没给恢复时间时的等待秒数，`0` 表示不施加这类冷却 | `21600` |
| `providers[].local_qps` / `min_interval_ms` | 本地限速 | Brave、千帆、Serper 默认 1 QPS，DuckDuckGo 间隔 2 秒 |
| `providers[].cooldown_max_s` | 覆盖该来源的冷却上限 | 全局值；DuckDuckGo 为 21600 |
| `credentials.<环境变量名>` | 凭据（key 或 SearXNG 实例地址） | – |
| `defaults.timeout_ms` | 单个来源的请求超时 | `10000` |
| `defaults.total_budget_ms` | 整次搜索的总预算 | `30000` |
| `defaults.cooldown_default_s` / `cooldown_max_s` | 限流缺省冷却 / 冷却上限（秒） | `60` / `3600` |
| `defaults.max_output_chars` | 单次返回里正文（`content`/`snippet`）的总字符预算 | `12000` |
| `cache.enabled` | 是否启用缓存 | `true` |
| `cache.ttl_s` / `ttl_fresh_s` | 缓存 TTL，后者用于 `freshness=day` | `3600` / `900` |
| `cache.max_entries` | 缓存条数上限 | `512` |

## 网络与代理

- 设置 `HTTPS_PROXY`（或 `HTTP_PROXY`）后，所有出站请求走代理；`NO_PROXY` 按惯例列出直连的地址。没设 `NO_PROXY` 时，`localhost`、`127.0.0.1`、`::1` 默认直连，方便连本机的 SearXNG。生效的代理地址会显示在 `web_search_status` 里（账号密码已隐去）。
- 这件事需要网关自己处理：Node 自带的 fetch 不读这些变量，Node 22 实测设了 `HTTPS_PROXY` 依然直连。
- **国内网络：** DuckDuckGo 无法直连，所以"零配置"在国内需要代理才能工作；Tavily、Brave、Exa 也常需要代理。不想用代理的话，博查、智谱、千帆是国内服务，自建的 SearXNG 可以作为免 key 的兜底。

## 工具与返回值

### `web_search`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `query` | 必填 | 搜索词。网关截断到 400 字符；智谱、千帆还有更严的来源级截断，会在 `note` 里说明 |
| `max_results` | 8 | 1–20；超出范围或传成字符串会自动调整 |
| `freshness` | – | `day` / `week` / `month` / `year` |
| `include_domains` | – | 只返回这些主机名的结果；`https://docs.rs/x`、`site:docs.rs`、`*.docs.rs` 这类写法会自动归一成 `docs.rs` |
| `use_cache` | true | 是否读写缓存 |

调试参数 `provider`（强制只查一家）只在 `SEARCH_FAILOVER_DEBUG=1` 时出现。工具描述按当前可用的来源生成。

返回 `results[]` 和 `meta`。每条结果一定有 `title` 和 `url`；正文在 `content`（来源给出较长摘要时）或 `snippet`（只有短摘要时），两者不会同时出现，也可能都缺失。所有结果的正文合计超过 `defaults.max_output_chars` 时，按比例缩短较长的条目，并在 `note` 里说明（宿主普遍对工具输出有上限，比如 Claude Code 默认 25k token）。`meta` 里有 `provider_used`、完整的 `fallback_chain`、`cache_hit`、`elapsed_ms` 和可选的 `note`。

怎么读 `fallback_chain`：

| outcome | 含义 |
| --- | --- |
| `no_results` | 这一家正常返回了空结果 |
| `rate_limited` `quota_exhausted` `auth_failure` `timeout` `network` `server_error` `request_error` | 这一家失败了，处理方式见[工作方式](#工作方式) |
| `budget_exhausted` | 请求已经发出，但整次搜索的总预算先用完了 |
| `skipped:<原因>` | 这次没有请求这一家：仍在冷却（`auth_failure` 的 detail 是 `until_restart`）、`quota_local`（本地预算用完）、`local_rate`（限速等不到）、`budget_exhausted`（总预算已用完） |
| `config_error` / `no_provider` / `internal_error`（provider 为 `gateway`） | 配置错误 / 没有可用来源 / 网关自身异常 |

空结果的判断：链非空且全是 `no_results`，是正常的空搜索；有任何失败或跳过，或者没有可用的来源，MCP 返回 `isError: true`。

### `web_search_status`

没有参数。返回每家来源的状态、配置它的环境变量、屏蔽原因和剩余时间、连续失败次数、本地用量（达到 90% 预警），以及配置文件位置与错误、代理、缓存统计。节选：

```jsonc
{
  "version": "0.4.0",
  "providers": [
    { "name": "bocha", "in_chain": true, "credential_env": "BOCHA_API_KEY", "state": "blocked(quota_exhausted, 21600s left)", "used_requests": 1, "quota_profile": "monthly:1000@day1" },
    { "name": "tavily", "in_chain": true, "credential_env": "TAVILY_API_KEY", "state": "active", "used_requests": 1, "quota_profile": "monthly:1000@day2" },
    { "name": "zhipu", "in_chain": false, "credential_env": "ZHIPU_API_KEY", "state": "unconfigured" }
    // …
  ],
  "config": { "source": "/Users/me/.config/search-failover/config.json", "error": null, "warnings": [] },
  "network": { "proxy": "http://127.0.0.1:7890" },
  "cache": { "entries": 1, "hits": 0, "misses": 1 },
  "uptime_s": 42
}
```

### 排错

| `web_search_status` 里看到 | 含义 | 怎么办 |
| --- | --- | --- |
| `config.error` 不为空 | 配置文件或环境变量有错，所有搜索都不会执行 | 按提示的位置修正，重启宿主 |
| `config.warnings` 提到 unexpanded template | 宿主没有展开 `${...}`，这个值被忽略了 | 写成真实的值，或者改用配置文件 |
| `unconfigured` | 没读到这一家的凭据（`credential_env`） | 设置环境变量或配置文件的 `credentials`，重启宿主 |
| `disabled` | 有凭据，但不在运行链里（可选源默认不进链） | 加进 `SEARCH_FAILOVER_PROVIDERS` 或 `providers` |
| `disabled(auth_failure)` | key 被上游拒绝，已摘除到重启 | 换 key，重启宿主 |
| `blocked(<原因>, Ns left)` | 冷却中 | 等待，或看 `last_error` |
| `blocked(quota_local)` | 本地请求预算用完 | 调大 `quota.limit`，或等下个周期 |
| `active` | 可用 | – |

## 状态与局限

- **状态只在进程内存里。** 计数、限速、冷却和缓存重启即清零。stdio 模式下每个宿主各有一个进程，互不共享；需要共享时用 HTTP 模式，让多个宿主连同一个进程。计数也不包含其他应用对同一个 key 的消耗。
- **相同查询并发时不合并请求。** 两个一模一样的请求同时到达，各请求一次上游。
- **不合并多家结果。** 第一家返回非空结果就结束；这是容灾网关，不是元搜索引擎。
- **部分来源还没用真实 key 校准。** 智谱、千帆、Serper、SearXNG 的契约测试用的是按官方文档构造的响应；博查、Brave 的"无结果"响应格式依据官方实现和响应模型推断。`scripts/probe.mts` 就是用来采集真实响应的（包括必然无结果的查询），手上有 key 的话，欢迎跑一遍并把脱敏后的结果贴到 issue 里。
- **DuckDuckGo 靠抓取 HTML 页面。** 免 key，但受网络和反爬限制，页面改版可能失效；遇到不认识的页面结构会报错，不会当成空结果。
- **宿主兼容。** OpenCode、VS Code 的配置依官方文档编写，尚未在客户端实测；Cursor 的官方插件市场仍在审核。HTTP 模式在本地用 MCP SDK 客户端测过，还没逐个平台验证。

## 开发与发布

```bash
npm run dev         # tsx 本地起服（stdio）；加 -- --http 起 HTTP 模式
npm test            # 单元 / 契约 / Router 集成 / stdio 与 HTTP e2e
npm run typecheck   # tsc --noEmit
npm run build       # esbuild 打包成单文件 dist/index.js
node scripts/runtime-smoke.mjs dist/index.js   # 用构建产物跑一遍 stdio 冒烟（上游是模拟的）
```

仓库自带的 `.cursor/mcp.json`、`.zcode/config.json` 指向本地构建（先 `npm run build`），在 Cursor / ZCode 里打开仓库就能用到工作区里的代码；ZCode 需要以仓库根目录为工作目录。

接入新来源：在 `src/providers/` 新建 adapter，导出包含凭据变量、默认值和能力的 `definition`，在 `src/providers/registry.ts` 加一行，补契约测试，再跑 `npm run plugin:sync`：Cursor 插件变量和上面的来源表格会自动更新。流程是 probe-first：先 `npx tsx scripts/probe.mts <provider>` 用真实 key 采集正常、必然无结果、错误 key、越界参数四种响应的脱敏快照，再据此校准契约测试。

插件清单：`npm run plugin:check`（结构、生成内容和锁定版本校验，`prepublishOnly` 会跑）、`npm run plugin:sync`（重新生成 Cursor 变量和来源表格）、`node scripts/plugin-sync.mjs --published`（确认清单锁定的版本在 npm 上已发布，CI 会跑）。清单锁定的版本由发布 workflow 自动更新，不需要手动改。

发布冒烟按插件同款命令拉起真实分发包，跑完 initialize → tools/list → status → 真实搜索：`node scripts/smoke-stdio.mjs`，支持 `--env KEY=V`、`--config /绝对路径/config.json`、`--command node -- dist/index.js`（本地构建）。

<details>
<summary>发布流程（自动化）</summary>

版本号由 [release-please](https://github.com/googleapis/release-please) 根据 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 决定，不再手动改版本：

1. **提交规范。** PR 用 squash 合并，PR 标题就是进入 main 的提交信息，`PR title` workflow 会检查格式：`fix:` 升 patch，`feat:` 升 minor，`feat!:` 或正文里写 `BREAKING CHANGE:` 升 major（1.0 之前升 minor）。`docs:`、`chore:`、`ci:`、`test:` 等不触发发版。
2. **发布 PR。** 每次合并到 main，release-please 会创建或更新一个 `chore: release x.y.z` PR，里面改好 `package.json`、lockfile 和 CHANGELOG。想发版时合并它。
3. **自动发布。** 合并发布 PR 后，`Release` workflow 依次：打 tag 并创建 GitHub Release → 用 OIDC trusted publishing 发布到 npm → 确认 npm 上能装到后，运行 `plugin-sync --to x.y.z` 把插件清单锁定的版本回写到 main。

市场清单直接读 GitHub 默认分支，所以清单里锁定的始终是"最新已发布版本"：它可以落后于 `package.json`（发布 PR 合并后、npm 发布完成前），但不能超前；CI 的 `--published` 检查和 `plugin:check` 会拦住违反这两条的改动。

需要的仓库设置：

- 合并方式只开 squash，默认提交信息用 PR 标题。
- 建议配置 `RELEASE_TOKEN` secret（GitHub App token 或细粒度 PAT，需要 contents 和 pull requests 写权限）。默认 `GITHUB_TOKEN` 创建的发布 PR 和回写提交不会触发 CI；main 开了分支保护时，回写提交也需要这个 token 有推送权限。
- npm Trusted Publisher 绑定的是 `release.yml` 和 `release` 环境，不要改 workflow 文件名。

</details>

## 反馈

遇到某家搜索 API 的异常行为，欢迎提 [issue](https://github.com/crisweb1994/search-failover/issues)，最好附上脱敏后的响应体，它可以直接变成一条契约测试。

## 许可证

[MIT](LICENSE)
