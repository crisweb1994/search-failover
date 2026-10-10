# search-failover

[English](README.en.md) | [简体中文](README.md)

![npm](https://img.shields.io/npm/v/search-failover) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

A search failover gateway MCP: it exposes a single `search` tool and pools 8 search providers behind it — the default chain is Bocha → Tavily → Brave → Exa → DuckDuckGo, plus three opt-in providers (Zhipu / Baidu Qianfan / Serper, enabled explicitly via config file). Whenever a provider hits its quota, times out, or returns nothing, the gateway automatically falls through to the next one. Your agent never has to care about "which search API ran out of credits again."

> [!TIP]
> With zero API keys, the gateway can try DuckDuckGo. It needs no credentials but remains subject to network and anti-bot restrictions.

## Quick Start

No install needed — just `npx` (or `npm install -g search-failover`). To run from source: `git clone`, then `npm install && npm run build`.

Put API keys in environment variables — configure as many as you like; providers without a key are skipped automatically:

```bash
# —— Default chain (configured keys join automatically) ——
export BOCHA_API_KEY=...    # optional, best for Chinese-language search
export TAVILY_API_KEY=...   # optional, 1,000 requests/month
export BRAVE_API_KEY=...    # optional, local reference budget: 1,000 attempts/month
export EXA_API_KEY=...      # optional, monthly credits; local budget: 800 attempts, fetch on demand

# —— Opt-in chain (paid / one-time-credit providers: join only after
#    explicit enablement in the config file, see next section) ——
export ZHIPU_API_KEY=...       # Zhipu web_search, ¥0.01/request (included in GLM Coding Plan)
export QIANFAN_API_KEY=...     # Baidu Qianfan ai_search, 1,500 free requests/month (pay-as-you-go beyond)
export SERPER_API_KEY=...      # Serper.dev (Google results), local lifetime budget: 2,500 attempts (not credits)
```

### Enabling opt-in providers

Paid / one-time-credit providers are **kept out of the chain by default** (so an exported key can't be drained passively); they must be enabled explicitly in a config file. Note: once the config file contains a `providers` field it **replaces the whole default chain**, so the example below carries the existing five along:

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

Save as `search-failover.json` in the host's cwd (or point `SEARCH_FAILOVER_CONFIG` at a path — as a plugin the cwd is a cache directory, so always use an **absolute path**). With everything enabled the chain is: Bocha → Zhipu → Tavily → Qianfan → Brave → Serper → Exa → DDG.

## Hooking Up an MCP Host

### Plugin marketplace install (recommended)

This repo ships an [Agent Plugins 1.0](https://agent-plugins.org) package (see `plugin/`), with marketplace catalogs for Codex / Cursor / ZCode at the repo root:

**Codex** (CLI ≥ 0.117):

```bash
codex plugin marketplace add crisweb1994/search-failover
```

Then install search-failover from the plugin directory in the ChatGPT desktop app / Codex. For local development you can add the repo path directly: `codex plugin marketplace add ./search-failover`.

**ZCode**: Plugin Marketplace → Discover → `+` → paste `https://github.com/crisweb1994/search-failover` (or a local repo path) → install search-failover. Afterwards you can fill in `config_path` (absolute path to search-failover.json, optional — leave empty for built-in defaults) in the plugin's config panel.

**Cursor**: supports both Agent Plugins and native Cursor plugins (this repo carries both). The official marketplace submission is pending review; until then use the MCP config below, or add this repo's root `.cursor-plugin/marketplace.json` as a local directory.

**OpenCode**: no marketplace catalog — use the MCP config below.

> [!IMPORTANT]
> **Keys and opt-in providers are two different things:**
> - Without API keys, searches try DuckDuckGo (requires local Node ≥ 20.10, network access and an unblocked upstream).
> - The 7 API keys enter via **host process environment variables**: `BOCHA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY` / `ZHIPU_API_KEY` / `QIANFAN_API_KEY` / `SERPER_API_KEY` (DuckDuckGo needs none). `export` them before starting the host, or put them in the host config's `env` field.
> - **A key alone does not join the chain**: Zhipu / Qianfan / Serper are opt-in and require `enabled: true` in search-failover.json (see "Enabling opt-in providers" above). With only a key and no config change, these providers in the default list appear as `disabled` in `status`.
> - As a plugin the process cwd is a plugin cache directory, so `SEARCH_FAILOVER_CONFIG` must be an **absolute path**.

### Cursor (MCP config)

Global `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

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

`${env:NAME}` is Cursor's variable interpolation — keys stay in your shell environment instead of the config file; delete the lines of providers you don't use.

### Codex (MCP config)

One command:

```bash
codex mcp add search-failover -- npx -y search-failover
```

Or `~/.codex/config.toml` (project-scoped `.codex/config.toml`):

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # npx cold start can exceed the 10s default

[mcp_servers.search-failover.env]
BOCHA_API_KEY = "..."
TAVILY_API_KEY = "..."
```

### ZCode (MCP config)

User-level `~/.zcode/cli/config.json` (project-level `<repo>/.zcode/config.json`) — note the nested `mcp.servers`:

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

ZCode's MCP schema is strict: `command` must be a string (never an array), the env field is named `env`, an unknown key silently drops the whole server, and `${...}` templates are not expanded in config files — write literal values.

### OpenCode (MCP config)

`opencode.json`:

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

Unlike the other hosts: `command` is an **array** (command and arguments together), and the env field is named **`environment`**. (Written per the official OpenCode docs; not yet verified in the client.)

### Other hosts (Claude Desktop etc.)

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

After a global install you can point directly at the binary: `"command": "search-failover"`. To run from source, use `"command": "node"` with `args` pointing at the absolute path of `dist/index.js`.

> [!NOTE]
> Optional config file `search-failover.json`: provider priority, monthly quota & reset day, cache TTL, total budget. Lookup order: the path in `SEARCH_FAILOVER_CONFIG` (must exist and be valid, otherwise startup fails) → same-named file in the host's cwd → all defaults. Every field has a default; omit the file to run on built-in defaults.

## Tools

`search` — 6 parameters:

| Parameter         | Default | Notes                                                                                      |
| ----------------- | ------- | ------------------------------------------------------------------------------------------ |
| `query`           | required | Search terms (gateway truncates at 400 chars; Zhipu/Qianfan apply stricter per-source truncation, see note) |
| `max_results`     | 8       | 1–20                                                                                        |
| `freshness`       | –       | `day / week / month / year`                                                                 |
| `include_domains` | –       | Only return results from these domains (native on Tavily/Exa/Qianfan; single-domain on Brave/Zhipu/Serper; ignored by Bocha/DDG) |
| `provider`        | –       | Force a single provider (for debugging)                                                     |
| `use_cache`       | true    | Same query, count and filters; default TTL 1 hour, 15 minutes for day                                        |

Returns `results[]` (title/url required; the text is in `content` when the source returns a longer summary, otherwise in `snippet` — never both, and sometimes neither) + `meta` (`provider_used`, the full `fallback_chain`, `cache_hit`, `note`). Read the decision chain for empty results: errors, blocked/quota/budget skips, or no runnable providers set MCP `isError: true`. Only a nonempty chain containing exclusively valid `no_results` is a normal empty search.

`status` — per-provider block state and remaining cooldown, failure streaks, quota usage with a 90% warning threshold, and cache hit statistics.

## Core Behavior

- **Sequential failover**: Bocha → Tavily → Brave → Exa → DDG (opt-in providers slot in by priority). First non-empty result wins; no same-provider retries — **failover is the retry**.
- **Error classification**: each adapter maps real signals to `rate_limited / quota_exhausted / auth_failure / timeout / network / server_error / request_error / no_results` (e.g. Bocha 403 = out of balance, Brave 429 body distinguishes per-second throttling from monthly quota, Zhipu 429+1113 = arrears, Serper 402 = credit exhausted, DDG 202 anomaly page = throttled).
- **Tiered cooldown**: each provider keeps `{blockedUntil, reason, failStreak}`; repeated failures double the cooldown up to a cap, then it lifts naturally at the deadline. No state machine, no circuit breaker.
- **Quota soft gate**: once the local counter reaches the configured `limit`, the provider is skipped with `skipped:quota_local` (no request sent); the authoritative stop signal remains upstream quota errors. Each synchronously admitted upstream attempt counts, including errors and cancellation after admission. Cache hits and cancellation while waiting do not. This is a conservative local request budget, not a bill. `monthly` resets at local-time reset_day; `one_time` accumulates for the process lifetime. `status.used_requests` is the new field; `used_this_month` remains a deprecated equal-value alias.
- **Upstream quota recovery**: use a valid future reset time returned by the provider; if missing, invalid or expired, wait for top-level provider `quota_retry_s` (default 21,600 seconds). Local `reset_day` never determines upstream recovery. No background probes run; the next search must still pass the local request budget gate.
- **Total budget 30s**: exhaustion records `skipped:budget_exhausted` and ends the search without penalizing provider health. Not every provider is guaranteed a turn. Client cancellation stops waiting/requests and prevents further fallback.
- **Opt-in against accidental drain**: paid / one-time-credit providers (Zhipu/Qianfan/Serper) stay out of the chain until explicitly enabled in the config file.


Omitted provider fields inherit that source's default priority, pacing, quota and cooldown. Opt-in providers still need explicit `enabled: true`. `providers: []` is an empty chain; unknown/duplicate names, unknown fields (including misspelled ones, such as `limt` for `limit`) and invalid numbers fail at startup, with the path of the offending field. Quota fields merge within the same type; changing type replaces them. Use `quota: { "type": "unbounded" }` to disable the local request limit.

Counters, pacing, cooldowns and cache are process-local, reset on restart, and are not shared across hosts or other applications using the same key. Local limits are not account balances or free-tier guarantees.

Pricing references (2026-10-04): [Brave](https://api-dashboard.search.brave.com/documentation/pricing)'s 1,000 attempts are a reference derived from monthly credits; local QPS stays at 1. [Exa](https://exa.ai/pricing) credits reset monthly; 800 is a retained local cap, not a guarantee of free usage. Serper credit tiers still require live verification; no guessed cost multiplier is applied.

DuckDuckGo needs no key but is subject to network and anti-bot restrictions. Providers apply different freshness semantics; Qianfan ignores `day` with a note. Cache hits retain the winning provider's degradation notes. All providers fetch `min(max_results, provider maximum)` without prefetching. Requested counts participate in cache keys, so different counts use separate entries and nonempty short responses can be cached. No extra requests fill short results. Forced-provider requests, use_cache=false and globally disabled caching bypass both reads and writes. Configure the TTLs with `cache.ttl_s` and `cache.ttl_fresh_s`; the latter applies to freshness=day.

### Configuration migration

`quota` describes only the local request budget. The fallback wait for upstream quota errors is now top-level provider `quota_retry_s`. For example, `{ "name": "bocha", "quota_retry_s": 600 }` waits 10 minutes when the upstream supplies no valid recovery time, then permits an attempt on the next search. Zero applies no quota-error health cooldown; local budgets and pacing still apply.

Legacy fields remain accepted and validated against their original ranges:

- `quota.quota_retry_s` is promoted to the provider level. An explicit top-level value wins; invalid legacy values still fail.
- `provider.fetch_policy` and `cache.store_size` are ignored and no longer control fetching or cache writes.

These legacy fields produce no notice and config files are never rewritten; any other unknown field is an error (see above).

Separate cache entries for different counts may increase upstream requests. Users with a small legacy store_size may fetch more results per request, and a fixed recovery interval can cause periodic attempts against providers still out of balance. Actual cost depends on billing and usage; lower cost is not guaranteed.

## Development

```bash
npm run dev         # start locally via tsx
npm test            # unit / contract / router integration / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
```

Provider onboarding is probe-first: run `npx tsx scripts/probe.mts <provider>` with a real key first, capture redacted response snapshots into `test/fixtures/`, then calibrate the adapter's contract tests against the snapshots — hand-written fixtures from documentation are forbidden.

Logging goes to stderr (`LOG=error|warn|info|debug`); stdout carries MCP protocol frames only.

Plugin manifest validation & version sync: `npm run plugin:check` (structural validation, also runs in `prepublishOnly`) / `npm run plugin:sync` (propagates the package.json version into the plugin manifests, marketplace catalogs and the pinned npx version).

Release smoke test (boots the real distributed package with the same command the plugin manifests use, then runs the full handshake initialize → tools/list → status → a live search): `node scripts/smoke-stdio.mjs` (supports `--env KEY=V`, `--config /abs/path/search-failover.json`, and `--command node -- dist/index.js` for a local build).

### Releasing (npm + plugin manifest sync)

The npx version pinned in the marketplace catalogs must correspond to an npm package, so the release order is fixed:

```bash
npm version 0.3.0 --no-git-tag-version   # 1. state the target version explicitly (don't rely on patch)
npm run plugin:sync                       # 2. sync 3 manifests + 3 marketplace catalogs + 3 pinned npx versions
npm run plugin:check && npm test          # 3. validate (prepublishOnly runs it again)
git add -A && git commit -m "release: 0.3.0"  # 4. version bump and manifests must land in one commit
# 5. tag / GitHub Release → CI publishes to npm
```

There is a window of a few minutes between the Release and CI finishing the npm publish, during which the catalogs already point at the new version but npm can't install it yet — don't announce the plugin update inside that window.
