# Changelog

本文件记录项目的所有显著变更，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。从 0.5.0 起，版本条目由 [release-please](https://github.com/googleapis/release-please) 根据 Conventional Commits 自动生成（英文）；0.5.0 的升级说明和更早的版本是手写的。

## [0.5.0](https://github.com/crisweb1994/search-failover/compare/v0.4.0...v0.5.0) (2026-10-18)


### Features

* add DeepSeek search provider ([954305f](https://github.com/crisweb1994/search-failover/commit/954305f3f074d6999d36281fedee3ff3a14e7ace))
* add DeepSeek search provider ([39030df](https://github.com/crisweb1994/search-failover/commit/39030df4067503921d99ca179f01bfb96125258f))
* add issue permissions for release-please in workflow ([c10cc40](https://github.com/crisweb1994/search-failover/commit/c10cc40a5471d44b59aaa465e9c23b41ff4966a3))
* add issue permissions for release-please in workflow ([66433b2](https://github.com/crisweb1994/search-failover/commit/66433b2244d3a17746e24e6d251ddde0858f4aec))
* multi-host config, HTTP transport, proxy and SearXNG ([535107d](https://github.com/crisweb1994/search-failover/commit/535107dc84d36ef6e04dcf496c9fb2b9e4a8ebf5))


### Bug Fixes

* reject unknown config fields at startup instead of ignoring them ([dd68658](https://github.com/crisweb1994/search-failover/commit/dd686583990a09af98ec45b07a6a2e5b65eb0f8a))
* report until_restart for auth-blocked providers and tidy up ([bcb3dc0](https://github.com/crisweb1994/search-failover/commit/bcb3dc0c779652cd43e4a343332f8bbb57963ebf))
* stop returning snippet when content is present ([9d30102](https://github.com/crisweb1994/search-failover/commit/9d30102658133a938e0a7c258a3ecee2795448a3))

## 0.5.0 升级说明

以下是 0.5.0 改动的详细说明，自动生成的版本条目见上方。

### 不兼容变更

- 工具改名：`search` → `web_search`，`status` → `web_search_status`，避免在不做命名空间的宿主里和其他 server 的同名工具冲突。
- 不再读取当前目录下的 `search-failover.json`。配置文件改为 `SEARCH_FAILOVER_CONFIG` 指定的路径，或用户级 `~/.config/search-failover/config.json`（`$XDG_CONFIG_HOME` 优先，Windows 为 `%APPDATA%`）。此前宿主以某个仓库为工作目录启动时，仓库里的配置文件可以替用户打开付费来源。
- `providers` 的数组顺序就是优先级，`priority` 字段移除；列出即启用（包括可选源），`enabled: false` 可以暂时停用。
- 移除废弃字段 `fetch_policy`、`cache.store_size`、`quota.quota_retry_s` 和 status 的 `used_this_month` 别名（尚无存量用户），写了会按未知字段报错。
- 配置错误不再让进程退出：网关照常启动但不运行任何来源，每次搜索都返回 `config_error` 和出错位置，`web_search_status` 里也能看到。此前宿主那边只能看到连接断开。
- 已经发出请求、但总预算先用完的来源记为 `budget_exhausted`；`skipped:` 前缀只表示这次没有请求。
- 工具描述、参数说明、降级说明和日志改为英文；工具描述按实际运行链生成，不再列出未配置的来源。
- 调试参数 `provider` 只在 `SEARCH_FAILOVER_DEBUG=1` 时出现。

### 新增

- Streamable HTTP 模式：`--http [--host 127.0.0.1] [--port 8787]`，无状态，所有客户端共享额度计数、冷却和缓存。监听非本机地址必须设置 `SEARCH_FAILOVER_HTTP_TOKEN`；token 可以放在 `Authorization` 头或 `?token=` 里；不设 token 时只接受本机的 Host / Origin，防 DNS rebinding。
- SearXNG 来源（`SEARXNG_URL`，自建实例，免 key），在默认链中排在 DuckDuckGo 之前。
- `SEARCH_FAILOVER_PROVIDERS` 环境变量：只用环境变量就能指定运行链和顺序。
- 配置文件的 `credentials` 段：以环境变量名为键，所有宿主共用一份凭据；同名环境变量优先。
- 出站代理：读取 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（Node 自带的 fetch 不读这些变量），本机地址默认直连。
- server `instructions`、工具 `title` 和只读 `annotations`。
- 输出总量预算 `defaults.max_output_chars`（默认 12000 字符）：超出时按比例缩短较长的正文，并在 `note` 里说明。
- `web_search_status` 增加 `in_chain`、`credential_env`、配置文件位置与错误、未展开模板的告警、代理和版本号；命令行增加 `--version` / `--help`。
- 输入归一化：`include_domains` 接受 URL、`site:`、`*.` 写法和单个字符串；`max_results` 接受数字字符串并截到 1–20；`freshness` 忽略大小写。

### 修复

- 博查没有结果时省略 `webPages`（官方 MCP 同样按"无结果"处理），此前被判成 `server_error` 并逐次加长冷却；Brave 没有 `web` 字段时同理。
- 带 `include_domains` 时先试能执行过滤的来源；降级说明只来自最终给出结果的那一家，此前失败来源的说明会留在结果里，同一查询命中缓存时又会消失。DuckDuckGo 支持单域名过滤（`site:`）。
- 宿主没展开的 `${...}` 模板和空值视为未设置，此前会被当成 key，401 后来源被摘除，提示还指向"key 被拒绝"。
- 网络错误的 detail 带上真实原因（ENOTFOUND、ECONNREFUSED、证书错误等），此前只有 "fetch failed"。
- key 无效而被摘除的来源，后续搜索的跳过原因由 `9007199254741s` 改为 `until_restart`。
- 智谱没有错误体时 detail 不再出现 `NaN`。

### 变更

- 发布包改为 esbuild 打出的单个文件，没有运行时依赖（此前约 100 个依赖包）：`npx` 冷启动更快，安装结果也不会随依赖更新漂移。
- 来源的凭据变量、默认值和能力集中在各 adapter 的 `definition` 里；Cursor 插件变量和 README 来源表格由 `npm run plugin:sync` 从注册表生成。ZCode 插件增加 `providers` 配置项。
- 发布流程改为先从发布分支发布到 npm、再合并到 main；CI 用 `plugin-sync --published` 拦住指向未发布版本的清单（0.3.0 曾在 main 上指向 npm 上不存在的版本）。CI 增加 Windows / macOS 的构建产物冒烟。
- 结果正文只出现在一个字段：来源给出 `content` 时不再重复返回由它截取的前 300 字 `snippet`，只有短摘要的来源仍返回 `snippet`。全空白的正文视同缺失。
- 上游配额错误的恢复规则与本地请求预算解耦：有效的未来恢复时间优先，否则使用 `quota_retry_s`（默认 6 小时），不再按本地 `reset_day` 推算。
- 所有来源统一按 `max_results` 按需取数；条数纳入缓存 key，非空短结果也会缓存，可能增加上游请求次数。
- probe 脚本覆盖全部来源，并增加一条必然无结果的查询，用来确认各家空结果的真实格式。
- npm 包的 `files` 不再包含 `docs/`；过时的 `TECH_SIMPLIFICATION.md` 移出仓库。

## [0.4.0] — 2026-10-07

- 自定义 providers 条目继承注册表默认保护；空名单保留，未知/重复名称与非法数值启动时报错。
- 本地 limit 改为同步批准的上游尝试数，错误及批准后的取消也计数；monthly 读取时重置，one_time 不跨月归零。新增 used_requests，used_this_month 暂留同值别名；计数不代表供应商费用。
- 修复并发限速和准入竞争；透传 MCP 取消，总预算耗尽不再惩罚来源健康。
- 非法成功响应、响应超限不再伪装为空结果；参数错误使用 request_error，不屏蔽来源。未完整完成的空搜索使用 MCP isError。
- 千帆请求使用 resource_type_filter 数组，读取 references/web，day 过滤明确降级。真实千帆接口仍待凭据验证。
- 缓存命中保留降级说明；Exa、无缓存和指定来源调用按需取数。Brave 本地参考预算 1000，Exa 改为 monthly、保留本地 800 上限。
- DDG 使用 htmlparser2 按条目解析摘要并过滤广告，未知结构报错；新增 PR/push CI 和最低 Node 打包产物 smoke。


## [0.3.0] — 2026-10-02

> 0.3.0 没有发布到 npm，这些改动随 0.4.0 一起发布。

### Added

- 插件市场分发：新增 `plugin/` 目录（Agent Plugins 1.0 `plugin.json` + `mcp.json`、Cursor 原生清单 `.cursor-plugin/plugin.json`、ZCode 清单 `.zcode-plugin/plugin.json` + `.mcp.json`、英文 `skills/web-search/SKILL.md`）。
- 三份市场清单：`.agents/plugins/marketplace.json`（Codex）、根 `marketplace.json`（ZCode）、`.cursor-plugin/marketplace.json`（Cursor），均指向 `./plugin`。
- `scripts/plugin-sync.mjs`：版本同步（写模式）+ 结构级校验（`--check`，已挂进 `prepublishOnly`）——校验 manifest schema、npx 锁定版本一致性、共享 mcp.json 禁止占位符进 env、ZCode userConfig 禁止 sensitive 项等。
- `scripts/smoke-stdio.mjs`：发布冒烟——用插件同款 `npx -y search-failover@<version>` 拉起真实分发包，跑完整握手（initialize → tools/list → status → 真实搜索），支持注入单 key / 绝对路径配置文件两种场景。
- README 中英双语补齐四平台接入文档（Cursor / Codex / ZCode / OpenCode 各自的配置格式与坑），并区分「配 key」与「启用可选源」；新增插件市场安装入口与发布 SOP。
- 开发便利：仓库级 `.cursor/mcp.json` 与 `.zcode/config.json`（零 key，DDG 兜底）——本仓库在 Cursor / ZCode 中打开即自动挂载 search-failover。

## [0.2.0] — 2026-10-01

### Added

- 扩源至 8 家：新增智谱 web_search、百度千帆 ai_search、Serper 三家可选源（付费 / 一次性额度，配置文件显式开启后才进链）。
- 注册表（`REGISTRY`）成为源名单的单一事实来源：默认配置、MCP describe 文本、测试一致性断言全部由它派生。
- 配额软闸门：本地计数达到配置 `limit` 时该源记 `skipped:quota_local` 直接跳过，不再发请求；权威停发仍是上游配额类错误。
- `include_domains` 域名过滤参数（各源能力分级：原生支持 / 单域名 / 忽略并在 note 说明）。
- probe-first 接源流程：`scripts/probe.mts <provider>` 用真实 key 采集上游响应脱敏快照，契约测试据快照校准，禁止凭文档手写 fixture。
- 本 CHANGELOG 与英文版 README（`README.en.md`）。

### Fixed

- **DuckDuckGo challenge 误判**：封禁页关键词检测（anomaly/challenge/captcha/blocked）改为复合条件（解析出 0 条结果 **且** 含关键词）。此前正常结果页的标题/摘要里出现这些词（如搜索 "coding challenge"、"captcha"）会被误判为封禁页，导致 DDG 被屏蔽 6 小时——对零 key 用户（DDG 是唯一源）直接不可用。
- **`reset_day=31` 月末漂移**：配置了 31 号重置的源在小月（30/28 天）会被 JS Date 自动滚入下月 1 日，导致计费窗口漂移；现在 clamp 到当月月末。
- 博查错误信息 `bodyMsg` 对同一响应体重复 JSON 解析两次，改为解析一次。
- 响应体读取加上限（512KB）：上游异常大的响应（如 challenge 页堆积 JS）不再无界读入内存，超出部分流式截断。

### Changed

- 缓存逐出策略 FIFO → LRU（命中/重写提升热度），并新增每 16 次写入触发的惰性过期清扫，释放被过期条目占用的名额。
- 版本号单一来源化：MCP serverInfo 的版本运行时从 `package.json` 读取，不再与源码双处硬编码。
- DuckDuckGo 大响应（>1KB）解析出 0 条结果时记 warn 日志，页面结构改版可感知（不再静默失败）。

## [0.1.1] — 2026-09-30

### Fixed

- `repository.url` 去掉 `git+` 前缀：npm OIDC Trusted Publisher 的匹配对它敏感。
- lockfile 的 resolved URL 指向 npmmirror，导致 CI 中 `npm ci` 失败。

## [0.1.0] — 2026-09-30

首个版本。

### Added

- 5 源聚合（博查 / Tavily / Brave / Exa / DuckDuckGo）+ 顺序容灾：任何一家限额、超时或空结果自动切换下一家，failover 即重试。
- 两档 TTL 缓存（fresh/stale），同参数查询 1 小时内秒回且不耗配额。
- 六类错误分类（rate_limited / quota_exhausted / auth_failure / timeout / network / server_error），针对各家反直觉行为精确映射（Brave 422=auth、DDG 202=限流、博查 403=余额不足等）。
- 阶梯冷却、总预算 30s、stdout 纯净性（日志全走 stderr）。
