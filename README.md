# search-failover

[简体中文](README.md) | [English](README.en.md)

![npm](https://img.shields.io/npm/v/search-failover) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

搜索故障转移网关 MCP：对外只暴露一个 `search` 工具，内部池化 8 个搜索源——默认链为博查 → Tavily → Brave → Exa → DuckDuckGo，另有三家可选源（智谱 / 百度千帆 / Serper，配置文件显式开启），任一家限额、超时或空结果时自动切换下一家。你的 agent 从此不必关心"哪家搜索又没额度了"。

> [!TIP]
> 不配置 API key 时可尝试 DuckDuckGo；它不需要凭据，但受网络和反爬限制。



## 快速开始

无需安装，直接 `npx` 就能跑（也可以 `npm install -g search-failover`）；从源码跑则 `git clone` 后 `npm install && npm run build`。

API key 放环境变量即可，配几个用几个，没配的源自动跳过：

```bash
# —— 默认链（配 key 即自动加入）——
export BOCHA_API_KEY=...    # 可选，中文搜索最强
export TAVILY_API_KEY=...   # 可选，1000 次/月
export BRAVE_API_KEY=...    # 可选，本地参考预算 1000 次/月
export EXA_API_KEY=...      # 可选，月度 credits；本地预算 800 次，按需取数

# —— 可选链（付费/一次性额度源：配置文件显式开启后才进链，见下节）——
export ZHIPU_API_KEY=...       # 智谱 web_search，¥0.01/次（GLM Coding Plan 含次数）
export QIANFAN_API_KEY=...     # 百度千帆 ai_search，1500 次/月免费（超额按量）
export SERPER_API_KEY=...      # Serper.dev（Google 结果），本地一次性预算 2500 次（不等同 credits）
```

### 启用可选源（opt-in）

付费 / 一次性额度的源默认**不进链**（防止配了 key 被动消耗），需要在配置文件里显式开启。注意：配置文件一旦写了 `providers` 字段就**整体替换**默认链，示例里把存量五家一起带上：

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

存为宿主 cwd 的 `search-failover.json`（或用 `SEARCH_FAILOVER_CONFIG` 指定路径；插件形态下 cwd 是缓存目录，务必用**绝对路径**）。全开后链为：博查 → 智谱 → Tavily → 百度 → Brave → Serper → Exa → DDG。



## 接入 MCP 宿主

### 插件市场安装（推荐）

本仓库已按 [Agent Plugins 1.0](https://agent-plugins.org) 打包（见 `plugin/` 目录），Codex / Cursor / ZCode 三家的市场清单都在仓库根：

**Codex**（CLI ≥ 0.117）：

```bash
codex plugin marketplace add crisweb1994/search-failover
```

然后在 ChatGPT 桌面端 / Codex 的插件目录里安装 search-failover。本地开发验证可直接加仓库路径：`codex plugin marketplace add ./search-failover`。

**ZCode**：插件市场 →「发现」→ `+` → 粘贴 `https://github.com/crisweb1994/search-failover`（或本地仓库路径）→ 安装 search-failover。装完可在插件详情「配置」里填 `config_path`（search-failover.json 的绝对路径，可选，留空用内置默认）。

**Cursor**：同时支持 Agent Plugins 与 Cursor 原生插件两种格式（本仓库两者都带）。官方市场提交审核中；在此之前用下面的 MCP 配置，或以本地目录方式添加本仓库根的 `.cursor-plugin/marketplace.json`。

**OpenCode**：没有插件市场清单，走下面的 MCP 配置。

> [!IMPORTANT]
> **密钥与可选源是两件事：**
> - 不配 key 时尝试 DuckDuckGo（依赖本机 Node ≥ 20.10、网络和上游反爬状态）。
> - 7 个 API key 一律走**宿主进程环境变量**：`BOCHA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY` / `ZHIPU_API_KEY` / `QIANFAN_API_KEY` / `SERPER_API_KEY`（DuckDuckGo 免 key）。启动宿主前 `export`，或写进各宿主配置的 `env` 字段。
> - **配了 key ≠ 进链**：智谱 / 千帆 / Serper 是 opt-in 源，必须在 search-failover.json 里显式 `enabled: true` 才进链（见上文「启用可选源」）。只配 key 不改配置，默认名单中的这些来源会在 `status` 显示 `disabled`。
> - 插件形态下进程 cwd 是插件缓存目录，`SEARCH_FAILOVER_CONFIG` 请用**绝对路径**。

### Cursor（MCP 配置）

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

`${env:NAME}` 是 Cursor 的变量插值，key 留在 shell 环境里不进配置文件；不需要的源整行删掉。

### Codex（MCP 配置）

一条命令：

```bash
codex mcp add search-failover -- npx -y search-failover
```

或 `~/.codex/config.toml`（项目级 `.codex/config.toml`）：

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # npx 首次冷启动可能超过默认 10s

[mcp_servers.search-failover.env]
BOCHA_API_KEY = "..."
TAVILY_API_KEY = "..."
```

### ZCode（MCP 配置）

用户级 `~/.zcode/cli/config.json`（项目级 `<repo>/.zcode/config.json`），注意是嵌套的 `mcp.servers`：

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

ZCode 的 MCP schema 是严格的：`command` 必须是字符串（不能写数组）、环境变量字段名必须是 `env`、出现未知字段整条 server 会被静默丢弃；配置文件里不展开 `${...}` 模板，要写具体值。

### OpenCode（MCP 配置）

`opencode.json`：

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

注意与其它宿主不同：`command` 是**数组**（命令与参数写在一起），环境变量字段叫 **`environment`**。（本段依据 OpenCode 官方文档编写，尚未在客户端实测。）

### 其他宿主（Claude Desktop 等）

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
> 可选配置文件 `search-failover.json`：provider 优先级、月度配额与重置日、缓存 TTL、总预算。查找顺序：`SEARCH_FAILOVER_CONFIG` 指定路径（必须是存在的合法文件，否则启动失败）→ 宿主 cwd 下的同名文件 → 全默认。全字段有默认值，不写就按内置默认配置跑。



## 工具

`search` — 6 个参数：


| 参数                | 默认   | 说明                                                             |
| ----------------- | ---- | ----------------------------------------------------------------- |
| `query`           | 必填   | 搜索词（网关截 400 字符；智谱/百度有更严的源级截断，见 note）                    |
| `max_results`     | 8    | 1–20                                                              |
| `freshness`       | –    | `day / week / month / year`                                       |
| `include_domains` | –    | 仅返回这些域名的结果（Tavily/Exa/百度 原生支持，Brave/智谱/Serper 支持单域名，博查/DDG 忽略该参数） |
| `provider`        | –    | 强制指定单一源（调试用）                                                   |
| `use_cache`       | true | 相同查询、条数和过滤条件复用；默认 TTL 1 小时，day 为 15 分钟                                                      |


返回 `results[]`（title/url 必有，snippet 可缺失）+ `meta`（`provider_used`、完整 `fallback_chain`、`cache_hit`、`note`）。空数组必须结合决策链解释：有错误、屏蔽、额度/预算跳过或无可用来源时，MCP 返回 `isError: true`；只有非空链内全部为合法 `no_results` 时才是正常空结果。

`status` — 各源屏蔽状态与剩余时长、失败阶梯、配额用量与 90% 预警、缓存命中统计。

## 核心行为

- **顺序兜底**：博查 → Tavily → Brave → Exa → DDG（可选源开启后穿插其中），第一家非空即胜出；任何错误不做同源重试，**failover 即重试**。
- **错误分类**：每家 adapter 把真实信号映射为 `rate_limited / quota_exhausted / auth_failure / timeout / network / server_error / request_error / no_results`（如博查 403=余额不足、Brave 429 体区分秒级限速与月配额、智谱 429+1113=欠费、Serper 402=credit 耗尽、DDG 202 异常页=限流）。
- **阶梯冷却**：每源一个 `{blockedUntil, reason, failStreak}`，重复失败翻倍封顶，到点自然放行。无状态机、无熔断器。
- **配额软闸门**：本地计数达到配置的 `limit` 时该源记 `skipped:quota_local` 直接跳过（不再发请求）；权威停发仍是上游配额类错误。计数口径为“同步批准一次上游尝试即计数”，错误和批准后的取消也计数；缓存命中、等待中取消不计数。它是保守的本地请求预算，不模拟供应商账单。`monthly` 按本地时区/reset_day 重置，`one_time` 按进程累计；`status.used_requests` 为新字段，`used_this_month` 暂留同值兼容别名。
- **上游配额恢复**：优先采用上游明确返回的有效未来恢复时间；缺失、无效或已过期时，按来源顶层 `quota_retry_s` 等待（默认 21600 秒）。不根据本地 `reset_day` 推算上游恢复，也不后台探测；到期后的下一次搜索仍须通过本地预算闸门。
- **总预算 30s**：预算耗尽记录 `skipped:budget_exhausted` 后结束；不保证全链都被尝试，也不因预算不足惩罚来源健康。取消请求会停止等待/请求且不继续兜底。
- **opt-in 防误耗**：付费/一次性额度源（智谱/百度/Serper）默认不进链，须配置文件显式开启。


条目省略字段时继承该来源的默认优先级、限速、额度与冷却；opt-in 源仍须显式 `enabled: true`。`providers: []` 表示空链；未知/重复来源及非法数值会在启动时报错。quota 类型不变时合并字段；切换类型则使用新配置，例如 `quota: { "type": "unbounded" }` 关闭本地额度限制。

计数、限速、冷却与缓存均在单进程内；重启清零，不同宿主互不共享，也不合并其他应用对同一 key 的消耗。不要把本地 limit 当作账户余额或免费额度保证。

价格依据（2026-10-04）：[Brave](https://api-dashboard.search.brave.com/documentation/pricing) 的 1000 是月度 credits 折算参考，本地 QPS 保持 1；[Exa](https://exa.ai/pricing) 按月重置 credits，800 仅为兼容的本地上限，不保证落在免费额度内。Serper 分档计费尚待实测，本地不按推测倍数扣费。

DuckDuckGo 免 key，但受网络和反爬限制。`freshness` 由各源执行，日期语义和粒度可能不同，千帆 `day` 会忽略并提示。缓存命中保留获胜来源的降级说明。所有来源均按 `min(max_results, 来源条数上限)` 取数，不预取。条数参与缓存 key；不同条数分别缓存，非空短结果也可缓存，不为补足条数追加请求。指定 provider、use_cache=false 或全局关闭缓存时均绕过读写。两档 TTL 可通过 `cache.ttl_s` / `cache.ttl_fresh_s` 调整，后者用于 freshness=day。

### 配置迁移

`quota` 只描述本地请求预算；上游配额错误的等待间隔改为 provider 顶层 `quota_retry_s`。例如 `{ "name": "bocha", "quota_retry_s": 600 }` 表示缺少上游恢复时间时等待 10 分钟，再由下一次搜索尝试。`0` 表示不施加该类健康冷却，仍受本地预算和限速约束。

旧配置继续接受以下字段并校验原有合法值：

- `quota.quota_retry_s` 提升到顶层；同时配置时顶层值优先，非法旧值仍报错。
- `provider.fetch_policy` 与 `cache.store_size` 已忽略，不再控制取数或缓存写入。

启动时最多输出一条合并迁移提示到 stderr，遵循 LOG 设置。配置文件不会被自动改写。

不同条数不再共享缓存，可能增加请求次数；旧 store_size 较小时按需取数也可能增加单次返回量。固定恢复间隔可能带来对仍欠费来源的定期尝试。实际费用取决于供应商计费与使用分布，不承诺降低成本。

## 开发

```bash
npm run dev         # tsx 本地起服
npm test            # 单元 / 契约 / Router 集成 / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # 产出 dist/
```

新源接入流程（probe-first，D16）：先 `npx tsx scripts/probe.mts <provider>` 用真实 key 采集响应/错误体快照到 `test/fixtures/`，再据快照校准 adapter 契约测试——禁止凭文档手写 fixture。

日志走 stderr（`LOG=error|warn|info|debug`），stdout 永远只有 MCP 协议帧。

插件清单校验与版本同步：`npm run plugin:check`（结构级校验，`prepublishOnly` 会跑）/ `npm run plugin:sync`（把 package.json 版本同步进 plugin manifest、市场清单与 npx 锁定版本）。

发布冒烟（按插件同款命令拉起真实分发包，跑 initialize → tools/list → status → 真实搜索的完整握手）：`node scripts/smoke-stdio.mjs`（支持 `--env KEY=V`、`--config /绝对路径/search-failover.json`、`--command node -- dist/index.js` 本地构建）。

### 发布（npm + 插件清单同步）

市场清单里的 npx 锁定版本必须与 npm 上的包对应，因此发布顺序是固定的：

```bash
npm version 0.3.0 --no-git-tag-version   # 1. 显式写目标版本（不要依赖 patch）
npm run plugin:sync                       # 2. 同步 3 份 manifest + 3 份市场清单 + 3 处 npx 锁定版本
npm run plugin:check && npm test          # 3. 校验（prepublishOnly 还会再跑一遍）
git add -A && git commit -m "release: 0.3.0"  # 4. 版本与清单必须进同一个 commit
# 5. 打 tag / 建 GitHub Release → CI 发布 npm
```

Release 触发 CI 到 npm 发布完成之间有几分钟窗口，此刻市场清单已指向新版本但 npm 还装不到——窗口期内不要对外公告插件更新。



