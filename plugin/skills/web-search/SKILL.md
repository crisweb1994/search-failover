---
name: web-search
description: Search the web through the search-failover MCP server (web_search tool, automatic failover across several search APIs). Use it whenever an answer depends on current or external information — library docs, API versions, releases, news, error messages. Also explains how to read meta.fallback_chain and when to call web_search_status.
---

# Web search via search-failover

## When to search

Use `web_search` when the task depends on information you cannot reliably know from training data: recent releases, current library APIs, news, prices, unfamiliar error messages. Skip it for stable knowledge.

## Calling `web_search`

- `query` (required): a short, specific search phrase rather than a full sentence.
- `max_results`: 1–20, default 8.
- `freshness`: `day` / `week` / `month` / `year` for time-sensitive questions.
- `include_domains`: hostnames such as `docs.python.org`. Providers that can apply the filter are tried first; if the answer still came from one that cannot, `meta.note` says the filter was ignored.
- `use_cache`: `false` to bypass the cache (breaking news).

Results always have `title` and `url`; the text is in `content` (longer extract) or `snippet` (short summary), sometimes neither. Fetch the `url` when you need more.

## Reading the result

Check `meta.fallback_chain` before concluding anything from empty results.

| Outcome | Meaning | What to do |
|---|---|---|
| results returned | `meta.provider_used` answered | Use them |
| chain is all `no_results` | The search completed and found nothing | Rephrase once (broader terms, another language, fewer filters) |
| `auth_failure` / `skipped:auth_failure` | That provider's key was rejected; it stays off until restart | Tell the user to fix that key; other providers keep working |
| `rate_limited` / `quota_exhausted` | Throttled or out of quota; failover already ran | If every provider is limited, report it instead of retrying |
| `budget_exhausted` / `skipped:budget_exhausted` | The 30-second total budget ran out | The search did not complete; retry at most once, later |
| `skipped:quota_local` | The local request budget for that provider is used up | Mention it if nothing else answered |
| `request_error` | The provider rejected the parameters | Adjust the query or filters |
| `config_error` / `no_provider` (provider `gateway`) | Server configuration problem | Tell the user; call `web_search_status` for details |
| `internal_error` (provider `gateway`) | Gateway bug | Report it; do not retry blindly |

Whenever results are empty and the chain contains anything other than `no_results`, `isError` is true: say the search failed, not that nothing exists.

`meta.note` explains degradations: ignored filters, truncated queries, content trimmed to fit the output budget.

## `web_search_status`

No arguments. Shows each provider's state (`active`, `blocked(...)`, `unconfigured`, `disabled`), the environment variable that configures it (`credential_env`), local budgets, cache statistics, the proxy in use and any configuration error or warning. Use it when searches keep failing or the user asks which providers are active.

## Helping the user configure

- Credentials come from the host's environment variables (the `credential_env` in status), or from the `credentials` section of `~/.config/search-failover/config.json`, which every host shares.
- `SEARCH_FAILOVER_PROVIDERS` (comma-separated, in priority order) selects the chain. Zhipu, Qianfan and Serper are paid or one-off credit sources and only run when listed there or in the config file.
- With no keys at all, DuckDuckGo is used. It is unreachable from mainland China without a proxy (`HTTPS_PROXY`); a self-hosted SearXNG (`SEARXNG_URL`) is a free alternative.
