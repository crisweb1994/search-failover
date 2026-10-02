---
name: web-search
description: Retrieve current web results via the search-failover MCP server (aggregated search across Bocha/Tavily/Brave/Exa/DuckDuckGo with automatic failover). Use for any question that needs up-to-date online information — library docs, API versions, news, error messages, current events. Also covers how to read meta.fallback_chain outcomes and the status dashboard tool.
---

# Web search via search-failover

## When to use `search`

Reach for the `search` tool whenever the task depends on information you cannot reliably know from training data: recent releases, current library APIs, news, live prices/availability, or unfamiliar error messages. Do not use it for stable knowledge you already have.

## Calling `search`

- `query` (required): keep it a focused search phrase, not a full sentence. The gateway truncates at 400 characters.
- `max_results`: default 8, max 20.
- `freshness`: `day` / `week` / `month` / `year` for time-sensitive questions. This filters server-side — prefer it over trusting `publishedDate`, which is best-effort.
- `include_domains`: restrict results to specific sites (e.g. docs sites). Support varies by provider; some ignore it.
- `provider`: force a single provider — debugging only, defeats failover.
- `use_cache`: `false` to bypass the 1-hour cache (e.g. breaking news).

Every result has `title` / `url` / `snippet`. `content`, `publishedDate` and `score` are optional and often missing — fetch the `url` when the snippet is not enough.

## Decide from `meta.fallback_chain`, not from result count alone

Empty `results` has several very different causes. Check the last entries of `fallback_chain` before reacting:

| Outcome in chain | Meaning | What you should do |
|---|---|---|
| any step `ok` / results returned | `provider_used` responded | Proceed normally |
| chain ends with `no_results`, no errors | Genuinely nothing found for this query | Rewrite the query (broader terms, other language, fewer filters) and retry **once** |
| `auth_failure` | A provider rejected its credentials | Tell the user that provider's API key is wrong/missing; other providers carry on automatically |
| `rate_limited` / `quota_exhausted` | Provider throttled or out of quota | Failover already ran; if every provider is limited, report the quota situation instead of hammering retries |
| `skipped:budget_exhausted` | The 30s total budget ran out mid-chain | This search did **not** complete — do not conclude "no results"; optionally retry once later |
| `skipped:quota_local` | Local quota counter says this provider is spent | Expected behavior, not an error |
| `internal_error` (provider `gateway`) | The gateway itself hit a bug | Report the tool failure to the user; do not blind-retry |

Never treat `results: []` as "no information exists" without checking the chain — the distinction between "searched and found nothing" and "search did not complete" matters to the user.

## `status`

No-argument dashboard: per-provider blocked state and remaining cooldown, quota usage with 90% warnings, cache hit stats, uptime. Call it when searches behave oddly, or to answer "which providers are actually active right now?".

## Configuration facts worth knowing

- Works with **zero API keys**: DuckDuckGo is the always-available fallback (needs network and a local Node ≥ 20.10 via npx).
- API keys arrive through host environment variables: `BOCHA_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `ZHIPU_API_KEY`, `QIANFAN_API_KEY`, `SERPER_API_KEY` (7 keys; DuckDuckGo needs none).
- A key alone does **not** activate Zhipu / Qianfan / Serper: they are opt-in and must be enabled in `search-failover.json` (refer the user to the search-failover README if they ask why a keyed provider shows as disabled in `status`).
