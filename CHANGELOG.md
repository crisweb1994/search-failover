# Changelog

本文件记录项目的所有显著变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] — 2026-10-02

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
