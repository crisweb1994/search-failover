# search-failover

[English](README.en.md) | [简体中文](README.md)

![npm](https://img.shields.io/npm/v/search-failover) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![tests](https://img.shields.io/badge/tests-117%20passing-2EA44F) ![license](https://img.shields.io/badge/license-MIT-blue)

A search failover gateway MCP: it exposes a single `search` tool and pools 8 search providers behind it — the default chain is Bocha → Tavily → Brave → Exa → DuckDuckGo, plus three opt-in providers (Zhipu / Baidu Qianfan / Serper, enabled explicitly via config file). Whenever a provider hits its quota, times out, or returns nothing, the gateway automatically falls through to the next one. Your agent never has to care about "which search API ran out of credits again."

> [!TIP]
> It runs with zero API keys: DuckDuckGo needs no key and always sits at the end of the chain as the free fallback.

## Quick Start

No install needed — just `npx` (or `npm install -g search-failover`). To run from source: `git clone`, then `npm install && npm run build`.

Put API keys in environment variables — configure as many as you like; providers without a key are skipped automatically:

```bash
# —— Default chain (configured keys join automatically) ——
export BOCHA_API_KEY=...    # optional, best for Chinese-language search
export TAVILY_API_KEY=...   # optional, 1,000 requests/month
export BRAVE_API_KEY=...    # optional, 2,000 requests/month
export EXA_API_KEY=...      # optional, one-time $10 credit, ranked 4th to conserve it

# —— Opt-in chain (paid / one-time-credit providers: join only after
#    explicit enablement in the config file, see next section) ——
export ZHIPU_API_KEY=...       # Zhipu web_search, ¥0.01/request (included in GLM Coding Plan)
export QIANFAN_API_KEY=...     # Baidu Qianfan ai_search, 1,500 free requests/month (pay-as-you-go beyond)
export SERPER_API_KEY=...      # Serper.dev (Google results), one-time 2,500 searches
```

### Enabling opt-in providers

Paid / one-time-credit providers are **kept out of the chain by default** (so an exported key can't be drained passively); they must be enabled explicitly in a config file. Note: once the config file contains a `providers` field it **replaces the whole default chain**, so the example below carries the existing five along:

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

Save as `search-failover.json` in the host's cwd (or point `SEARCH_FAILOVER_CONFIG` at a path). With everything enabled the chain is: Bocha → Zhipu → Tavily → Qianfan → Brave → Serper → Exa → DDG.

## Hooking Up an MCP Host

ZCode / Claude Code / Cursor and friends:

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
> Optional config file `search-failover.json` (in the host's cwd, or a path via `SEARCH_FAILOVER_CONFIG`): provider priority, monthly quota & reset day, cache TTL, total budget. Every field has a default; omit the file to run on built-in defaults.

## Tools

`search` — 6 parameters:

| Parameter         | Default | Notes                                                                                      |
| ----------------- | ------- | ------------------------------------------------------------------------------------------ |
| `query`           | required | Search terms (gateway truncates at 400 chars; Zhipu/Qianfan apply stricter per-source truncation, see note) |
| `max_results`     | 8       | 1–20                                                                                        |
| `freshness`       | –       | `day / week / month / year`                                                                 |
| `include_domains` | –       | Only return results from these domains (native on Tavily/Exa/Qianfan; single-domain on Brave/Zhipu/Serper; ignored by Bocha/DDG) |
| `provider`        | –       | Force a single provider (for debugging)                                                     |
| `use_cache`       | true    | Same-argument queries served from cache within 1 hour                                        |

Returns `results[]` (title/url/snippet always present) + `meta` (`provider_used`, the full `fallback_chain`, `cache_hit`, `note`). When every provider is exhausted it returns an empty array plus the decision chain — **never an error**: "nothing found anywhere" is itself an informative answer.

`status` — per-provider block state and remaining cooldown, failure streaks, quota usage with a 90% warning threshold, and cache hit statistics.

## Core Behavior

- **Sequential failover**: Bocha → Tavily → Brave → Exa → DDG (opt-in providers slot in by priority). First non-empty result wins; no same-provider retries — **failover is the retry**.
- **Six error classes**: each adapter maps real signals to `rate_limited / quota_exhausted / auth_failure / timeout / server_error / no_results` (e.g. Bocha 403 = out of balance, Brave 429 body distinguishes per-second throttling from monthly quota, Zhipu 429+1113 = arrears, Serper 402 = credit exhausted, DDG 202 anomaly page = throttled).
- **Tiered cooldown**: each provider keeps `{blockedUntil, reason, failStreak}`; repeated failures double the cooldown up to a cap, then it lifts naturally at the deadline. No state machine, no circuit breaker.
- **Quota soft gate**: once the local counter reaches the configured `limit`, the provider is skipped with `skipped:quota_local` (no request sent); the authoritative stop signal remains upstream quota errors. Counting happens on response receipt (most providers bill empty results too) and is process-local, not persisted.
- **Total budget 30s**: when the budget runs out, remaining providers are marked `skipped:budget_exhausted` and the call returns immediately — the agent never hangs.
- **Opt-in against accidental drain**: paid / one-time-credit providers (Zhipu/Qianfan/Serper) stay out of the chain until explicitly enabled in the config file.

## Development

```bash
npm run dev         # start locally via tsx
npm test            # 117 cases: unit / contract / router integration / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
```

Provider onboarding is probe-first: run `npx tsx scripts/probe.mts <provider>` with a real key first, capture redacted response snapshots into `test/fixtures/`, then calibrate the adapter's contract tests against the snapshots — hand-written fixtures from documentation are forbidden.

Logging goes to stderr (`LOG=error|warn|info|debug`); stdout carries MCP protocol frames only.
