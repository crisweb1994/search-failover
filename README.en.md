# search-failover

[English](README.en.md) | [简体中文](README.md)

[![npm](https://img.shields.io/npm/v/search-failover)](https://www.npmjs.com/package/search-failover) [![CI](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![MCP](https://img.shields.io/badge/MCP-stdio-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

**One `search` tool, eight search APIs behind it.** When one runs out of quota, gets rate-limited, times out or comes back empty, the next one takes over.

[Quick start](#quick-start) · [Providers](#providers) · [How it works](#how-it-works) · [Hosts](#connect-your-host) · [Configuration](#configuration) · [Tools](#tools-and-responses) · [Limitations](#status-and-limitations)

## Why

When an agent's search tool is wired to a single API, that API's monthly quota, a rate limit or a network hiccup is enough to fail the search. Worse, if the tool swallows the failure and returns an empty array, the agent concludes the web has nothing on the topic and answers from training data, sounding sure of itself.

search-failover puts several search APIs behind one `search` tool and tries them in priority order. The first one that returns results ends the search. Every step is written into the response, so the agent can see which providers were tried, which were skipped, and why.

## What a response looks like

A search where Bocha is out of balance, Tavily is rate-limited and Brave returns results (the upstream responses are mocked, to show the response shape):

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
    // …remaining results omitted
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

`fallback_chain` lists every provider that came up empty. Bocha returned 403 (out of balance), recorded as `quota_exhausted`, and is not asked again for a while. Tavily returned 429, recorded as `rate_limited`, and is retried only after its cooldown. Brave returned results, so the search ended.

Read the chain when the results are empty, too. Only a chain made up entirely of normal `no_results` means nothing was found. If any provider errored or was skipped, the MCP result carries `isError: true`, meaning the search did not complete.

## Highlights

- **Automatic failover.** The default chain is Bocha → Tavily → Brave → Exa → DuckDuckGo, eight providers once the opt-in ones are on. The first non-empty result ends the search. A failure is never retried on the same provider; the next provider is the retry.
- **Errors classified by what each provider actually sends.** Bocha's 403 means out of balance, Brave reports an invalid key as 422 (not 401), the same 429 can mean a per-second limit or an exhausted monthly quota, and DuckDuckGo throttles with a 202 and an anomaly page. Each adapter handles its own provider and maps the signals to eight error classes, each with its own cooldown.
- **Responses written for the model.** A full decision chain. "Found nothing" and "search did not complete" are told apart by MCP's `isError`. Parameters a provider can't honor (Bocha has no `include_domains`, for instance) are called out in `note` instead of being dropped silently. The plugin also ships a Skill that teaches the model how to read the chain.
- **No surprise bills.** Paid or one-time-credit providers (Zhipu, Qianfan, Serper) stay out of the chain until you enable them in the config; a key alone is not enough. Most providers have a local request budget and pacing, and concurrent requests cannot overshoot them.
- **Works with no configuration.** With no API key it falls back to DuckDuckGo. `npx` starts it, and Codex and ZCode can install it from a plugin marketplace.
- **Small and auditable.** Three runtime dependencies (the MCP SDK, zod, htmlparser2). No database, no background tasks, all state in process memory. Logs go to stderr and stdout carries protocol frames only.

## Quick start

Requires Node ≥ 20.10. There is nothing to install; `npx` runs it.

**1. Get some API keys.** Configure as many as you like. With none at all it still runs, using DuckDuckGo only.

```bash
export BOCHA_API_KEY=...    # good at Chinese-language search
export TAVILY_API_KEY=...   # 1,000 requests/month
export BRAVE_API_KEY=...
export EXA_API_KEY=...
```

The other providers are listed under [Providers](#providers).

**2. Connect your host.** Codex as an example:

```bash
codex mcp add search-failover -- npx -y search-failover
```

For Cursor, ZCode, OpenCode, Claude Desktop and others, see [Connect your host](#connect-your-host).

**3. Check the state.** Have the agent call `status` once. Each provider shows up as `active`, `unconfigured` (the process saw no key) or `blocked`.

## Providers

| Provider | Env var | Priority | In default chain | Quota and billing | `include_domains` |
| --- | --- | --- | --- | --- | --- |
| Bocha | `BOCHA_API_KEY` | 1 | yes | local budget 1,000/month | not supported |
| Zhipu | `ZHIPU_API_KEY` | 2 | no | ¥0.01 per request (GLM Coding Plan includes some) | single domain |
| Tavily | `TAVILY_API_KEY` | 3 | yes | 1,000/month | native |
| Baidu Qianfan | `QIANFAN_API_KEY` | 4 | no | 1,500/month free, pay-as-you-go beyond | native |
| Brave | `BRAVE_API_KEY` | 5 | yes | local reference budget 1,000/month | single domain |
| Serper | `SERPER_API_KEY` | 6 | no | one-time credits; local lifetime budget of 2,500 attempts | single domain |
| Exa | `EXA_API_KEY` | 7 | yes | monthly credits; local budget 800 | native |
| DuckDuckGo | none | 8 | yes | no key; subject to network and anti-bot limits | not supported |

- The default chain is Bocha → Tavily → Brave → Exa → DuckDuckGo. The three providers marked "no" are paid or one-time-credit, so **a key alone does not put them in the chain**; they need `enabled: true` in the config file (see [Configuration](#configuration)). With everything on, the order is the priority column.
- A "local budget" is the gateway's own conservative count, meant to send fewer requests. It is not an account balance and does not guarantee you stay inside a free tier. Pricing references (2026-10-04): [Brave](https://api-dashboard.search.brave.com/documentation/pricing)'s 1,000 is derived from its monthly credits; [Exa](https://exa.ai/pricing) resets credits monthly and 800 is just a retained local cap; Serper's credit tiers still need live verification, so no guessed cost multiplier is applied.
- A provider that doesn't support `include_domains` (or doesn't support several domains) still runs the search, and `meta.note` says the filter was ignored.

## How it works

```text
search(query)
 ├─ cache hit     → return, no upstream call
 └─ miss → try providers in priority order; skip those cooling down, over their local budget, or that can't be paced in time
      Bocha    403 out of balance → blocked until recovery, next
      Tavily   429 rate limit     → cooldown, next
      Brave    results            → done, return results and fallback_chain
      Exa / DuckDuckGo …          (never reached)
```

The first non-empty result wins. Errors are never retried on the same provider: **moving to the next one is the retry**. Each provider keeps three things: blocked until when, why, and how many times in a row it has failed. It is let through again when the time is up, and that first request is the probe. No state machine, no circuit breaker.

How each kind of error is handled:

| Class | Typical signals | Handling |
| --- | --- | --- |
| `rate_limited` | 429; DuckDuckGo's anomaly page | Cool down for the time the upstream gives, else 60 s, capped at 1 h (6 h for DuckDuckGo) |
| `quota_exhausted` | Bocha 403; Exa and Serper 402; Tavily 432/433; Brave 429 + `QUOTA_LIMITED`; Zhipu 429 + 1113 | Blocked until the recovery time the upstream gives, else `quota_retry_s` (default 6 h) |
| `auth_failure` | 401; Brave 422 + `SUBSCRIPTION_TOKEN_INVALID` | Provider removed until restart |
| `timeout` / `network` | Request timeout, connection failure | Cool down from 30 s, doubling per consecutive failure, capped at 1 h |
| `server_error` | 5xx; unparseable response | Cool down from 60 s, doubling per consecutive failure, capped at 1 h |
| `request_error` | 400/422 and other bad-parameter errors | Provider is not blocked; next provider |
| `no_results` | A valid empty result | No penalty; next provider |

- **Total budget.** A whole search takes at most 30 s, and a single provider at most 10 s. When the budget runs out the chain records `skipped:budget_exhausted`; that is not counted against any provider, and not every provider is guaranteed a turn. When the host cancels a request, the in-flight request is aborted and no further fallback happens.
- **Two clocks that don't interfere.** If the upstream gives a recovery time it is used, otherwise the gateway waits `quota_retry_s`. The local `reset_day` only governs the local counter and is never used to guess when the upstream recovers. A finished cooldown only means the next search may try the provider again; nothing probes in the background, and that attempt must still pass the local budget check.
- **Local request budget.** Each approved upstream attempt counts once, including upstream errors and cancellation after approval; cache hits and cancellation while queued do not. Once the count reaches `quota.limit`, the provider is recorded as `skipped:quota_local` for that search and no request is sent. `monthly` resets at the local-time `reset_day`; `one_time` accumulates for the life of the process. The check and the count happen in one synchronous step, so concurrent requests cannot overshoot.

<details>
<summary>Cache and fetching</summary>

- The cache key is made of the normalized query (case and extra whitespace ignored), `max_results`, `freshness` and `include_domains`. The default TTL is 1 hour, 15 minutes for `freshness=day`; adjust with `cache.ttl_s` / `cache.ttl_fresh_s`.
- A forced `provider`, `use_cache=false` or a globally disabled cache bypasses both reads and writes. A cache hit keeps the winning provider's degradation notes.
- Every provider fetches `min(max_results, provider maximum)` results, with no prefetching. Different counts are cached separately, non-empty short results are cached too, and no extra request is made to fill a short result.
- `freshness` is carried out by each provider, so date semantics and granularity can differ. Qianfan ignores `day` and says so in `note`.

</details>

## Connect your host

| Host | How |
| --- | --- |
| Codex | Plugin marketplace, or `codex mcp add` |
| ZCode | Plugin marketplace, or a hand-written MCP config |
| Cursor | MCP config (the official marketplace submission is still in review) |
| OpenCode | MCP config (written from the official docs, not yet verified in the client) |
| Claude Desktop, Claude Code and others | The generic `mcpServers` config |

This repo ships an [Agent Plugins 1.0](https://agent-plugins.org) package (see `plugin/`), with marketplace catalogs for Codex / Cursor / ZCode at the repo root.

> [!IMPORTANT]
> **Keys and opt-in providers are two different things:**
> - API keys always come in through the **host process's environment variables** (names in [Providers](#providers)). `export` them before starting the host, or put them in the host config's `env` field.
> - **A key alone does not put a provider in the chain.** Zhipu, Qianfan and Serper need an explicit `enabled: true` in `search-failover.json`. With only a key and no config change they show as `disabled` in `status`.
> - As a plugin, the process cwd is a plugin cache directory, so `SEARCH_FAILOVER_CONFIG` must be an **absolute path**.

<details>
<summary>Codex</summary>

**Plugin marketplace** (CLI ≥ 0.117):

```bash
codex plugin marketplace add crisweb1994/search-failover
```

Then install search-failover from the plugin directory in the ChatGPT desktop app / Codex. For local development you can add the repo path directly: `codex plugin marketplace add ./search-failover`.

**MCP config**, one command:

```bash
codex mcp add search-failover -- npx -y search-failover
```

Or `~/.codex/config.toml` (project-scoped `.codex/config.toml`):

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # an npx cold start can exceed the 10s default

[mcp_servers.search-failover.env]
BOCHA_API_KEY = "..."
TAVILY_API_KEY = "..."
```

</details>

<details>
<summary>ZCode</summary>

**Plugin marketplace**: Discover → `+` → paste `https://github.com/crisweb1994/search-failover` (or a local repo path) → install search-failover. Afterwards you can fill in `config_path` (absolute path to search-failover.json, optional; leave it empty for built-in defaults) in the plugin's config panel.

**MCP config**: user-level `~/.zcode/cli/config.json` (project-level `<repo>/.zcode/config.json`). Note the nested `mcp.servers`:

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

ZCode's MCP schema is strict: `command` must be a string (never an array), the env field must be named `env`, an unknown key silently drops the whole server, and `${...}` templates are not expanded in config files, so write literal values.

</details>

<details>
<summary>Cursor</summary>

Cursor supports both Agent Plugins and native Cursor plugins, and this repo carries both. The official marketplace submission is still in review; until then use the MCP config, or add the repo's root `.cursor-plugin/marketplace.json` as a local directory.

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

`${env:NAME}` is Cursor's variable interpolation, so keys stay in your shell environment instead of the config file. Delete the lines of providers you don't use.

</details>

<details>
<summary>OpenCode</summary>

There is no marketplace catalog, so use the MCP config. `opencode.json`:

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

Unlike the other hosts, `command` is an **array** (command and arguments together) and the env field is named **`environment`**. This was written from the official OpenCode docs and has not been verified in the client.

</details>

<details>
<summary>Claude Desktop, Claude Code and others</summary>

For hosts that use the generic `mcpServers` format:

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

After a global install (`npm install -g search-failover`) you can point directly at the binary: `"command": "search-failover"`. To run from source, use `"command": "node"` with `args` pointing at the absolute path of `dist/index.js`.

</details>

## Configuration

It runs fine without a config file. To adjust something, create a `search-failover.json`. Lookup order: the path in `SEARCH_FAILOVER_CONFIG` (must exist and be valid, otherwise startup fails) → a file of that name in the host's cwd → all defaults.

An example that turns the opt-in providers on. Once a config contains `providers` it **replaces the whole default chain**, so the example carries the default five along:

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

Fields omitted from an entry inherit that provider's defaults (priority, pacing, quota, cooldown). Available fields:

| Field | Meaning | Default |
| --- | --- | --- |
| `providers[].name` | Provider: `bocha` `zhipu` `tavily` `qianfan` `brave` `serper` `exa` `duckduckgo` | required |
| `providers[].enabled` | Whether it joins the chain | `false` for opt-in providers, `true` for the rest |
| `providers[].priority` | Order; lower numbers go first | the priority in [Providers](#providers) |
| `providers[].quota` | Local request budget: `type` (`monthly` / `one_time` / `unbounded`), `limit`, `reset_day` (1–31) | per provider, see [Providers](#providers) |
| `providers[].quota_retry_s` | Seconds to wait after a quota error that carries no recovery time; `0` applies no such cooldown | `21600` |
| `providers[].local_qps` / `min_interval_ms` | Local pacing | Brave, Qianfan and Serper default to 1 QPS; DuckDuckGo to a 2 s interval |
| `providers[].cooldown_max_s` | Overrides this provider's cooldown cap | the global value; 21600 for DuckDuckGo |
| `defaults.timeout_ms` | Per-provider request timeout | `10000` |
| `defaults.total_budget_ms` | Budget for a whole search | `30000` |
| `defaults.cooldown_default_s` / `cooldown_max_s` | Default rate-limit cooldown / cooldown cap, in seconds | `60` / `3600` |
| `cache.enabled` | Whether the cache is on | `true` |
| `cache.ttl_s` / `ttl_fresh_s` | Cache TTLs; the latter applies to `freshness=day` | `3600` / `900` |
| `cache.max_entries` | Cache size cap | `512` |

Rules:

- `providers: []` is an empty chain.
- Unknown or duplicate provider names, unknown fields (including misspelled ones, such as `limt` for `limit`) and invalid numbers all fail at startup, with the path of the offending field.
- `quota` fields merge when the type is unchanged; changing the type replaces them. For example, `quota: { "type": "unbounded" }` turns the local limit off.

<details>
<summary>Migrating from older versions</summary>

`quota` now describes only the local request budget. The wait after an upstream quota error is the provider-level `quota_retry_s`: `{ "name": "bocha", "quota_retry_s": 600 }` waits 10 minutes when the upstream supplies no recovery time, and the next search may then try again.

These legacy fields are still accepted and validated against their original ranges:

- `quota.quota_retry_s` is promoted to the provider level. An explicit top-level value wins, and invalid legacy values still fail.
- `provider.fetch_policy` and `cache.store_size` are ignored and no longer control fetching or cache writes.

They produce no notice, and config files are never rewritten. Any other unknown field is an error.

Behavior changes: different counts no longer share a cache entry, which may increase upstream requests; with a small legacy `store_size` a search may now fetch more results per request; and the fixed recovery interval means a provider that is still out of balance gets tried periodically. Actual cost depends on provider billing and your usage, and is not promised to be lower than before.

</details>

## Tools and responses

### `search`

| Parameter | Default | Notes |
| --- | --- | --- |
| `query` | required | Search terms. The gateway truncates at 400 chars; Zhipu and Qianfan truncate more strictly and say so in `note` |
| `max_results` | 8 | 1–20 |
| `freshness` | – | `day` / `week` / `month` / `year` |
| `include_domains` | – | Only return results from these domains; support per provider is in [Providers](#providers) |
| `provider` | – | Force a single provider (for debugging) |
| `use_cache` | true | Whether to read and write the cache |

It returns `results[]` and `meta`. Every result has `title` and `url`. The text is in `content` when the provider returns a longer summary, otherwise in `snippet`; the two never appear together, and both may be missing. `meta` holds `provider_used`, the full `fallback_chain`, `cache_hit`, `elapsed_ms` and an optional `note`.

Reading `fallback_chain`:

| outcome | Meaning |
| --- | --- |
| `no_results` | This provider answered normally with an empty result |
| `rate_limited` `quota_exhausted` `auth_failure` `timeout` `network` `server_error` `request_error` | This provider failed; handling is in [How it works](#how-it-works) |
| `skipped:<reason>` | This provider was not asked this time. Reasons: still cooling down (`rate_limited` and so on; for `auth_failure` the detail is `until_restart`), `quota_local` (local budget spent), `local_rate` (pacing couldn't fit), `budget_exhausted` (total budget spent) |

How an empty result is judged: a non-empty chain made only of `no_results` is a normal empty search. Any failure or skip, or having no runnable provider at all, makes the MCP result `isError: true`.

### `status`

Takes no arguments. Returns each provider's state, block reason and remaining time, failure streak, local usage (with a warning at 90%), and cache hit statistics. An excerpt:

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

`used_requests` is the number of approved upstream attempts; `used_this_month` is a compatibility alias with the same value. In `state`, `剩` means "remaining": `blocked(rate_limited, 剩60s)` has 60 s left on its cooldown.

### Troubleshooting

| In `status` | Meaning | What to do |
| --- | --- | --- |
| `unconfigured` | The process saw no environment variable for this provider | Check the host's `env` config, then restart the host |
| `disabled` | A key is set, but this is an opt-in provider and the config lacks `enabled: true` | See [Configuration](#configuration) |
| `disabled(auth_failure)` | The key was rejected upstream; the provider is removed until restart | Replace the key and restart the host |
| `blocked(<reason>, 剩Ns)` | Cooling down | Wait, or look at `last_error` |
| `blocked(quota_local)` | The local request budget is spent | Raise `quota.limit` or wait for the next period |
| `active` | Usable | – |

## Status and limitations

- **State lives in process memory.** Counters, pacing, cooldowns and the cache reset on restart, are not shared between hosts, and do not include other applications' use of the same key. The local budget is a conservative request count, not an account balance.
- **Identical concurrent queries are not merged.** Two identical requests arriving together each hit the upstream.
- **Results from several providers are not merged.** The first non-empty result ends the search. This is a failover gateway, not a metasearch engine.
- **The three opt-in providers have not been calibrated against real keys.** The contract tests for Zhipu, Qianfan and Serper use responses built from the official docs (or third-party accounts), and their error-code mapping comes mostly from the same sources; the real Qianfan API still awaits credentials. `scripts/probe.mts` exists to capture real responses. If you have a key, please run it and post the redacted output in an issue.
- **DuckDuckGo is scraped from an HTML page.** It needs no key but is subject to network and anti-bot limits, and a page redesign can break it. An unrecognized page structure raises an error rather than being treated as an empty result.
- **Host support.** The OpenCode config was written from its official docs and has not been verified in the client; Cursor's official plugin marketplace submission is still in review.

## Development and releases

```bash
npm run dev         # start locally via tsx
npm test            # unit / contract / router integration / stdio e2e
npm run typecheck   # tsc --noEmit
npm run build       # emit dist/
```

To run from source: `git clone`, then `npm install && npm run build`. Logging goes to stderr (`LOG=error|warn|info|debug`); stdout carries MCP protocol frames only.

Provider onboarding is probe-first: run `npx tsx scripts/probe.mts <provider>` with a real key, capture redacted snapshots of responses and error bodies into `test/fixtures/`, then calibrate the adapter's contract tests against them, rather than hand-writing fixtures from documentation. Zhipu, Qianfan and Serper have not completed this step yet; see the limitations above.

Plugin manifest validation and version sync: `npm run plugin:check` (structural validation, also run by `prepublishOnly`) and `npm run plugin:sync` (propagates the `package.json` version into the plugin manifests, the marketplace catalogs and the pinned npx version).

The release smoke test boots the real distributed package with the same command the plugin manifests use, then runs the full handshake, initialize → tools/list → status → a live search: `node scripts/smoke-stdio.mjs` (supports `--env KEY=V`, `--config /abs/path/search-failover.json`, and `--command node -- dist/index.js` for a local build).

<details>
<summary>Releasing (npm + plugin manifest sync)</summary>

The npx version pinned in the marketplace catalogs must correspond to a package that exists on npm, so the order is fixed:

```bash
npm version <x.y.z> --no-git-tag-version   # 1. state the target version explicitly, don't rely on patch
npm run plugin:sync                         # 2. sync 3 manifests, 3 marketplace catalogs, 3 pinned npx versions
npm run plugin:check && npm test            # 3. validate (prepublishOnly runs it again)
git add -A && git commit -m "release: <x.y.z>"   # 4. version bump and manifests must land in one commit
# 5. tag / GitHub Release; CI publishes to npm
```

There is a window of a few minutes between the Release and CI finishing the npm publish, during which the catalogs already point at the new version but npm can't install it yet. Don't announce the plugin update inside that window.

</details>

## Feedback

If a search API behaves oddly, please open an [issue](https://github.com/crisweb1994/search-failover/issues), ideally with the redacted response body; it can become a contract test as is.

## License

[MIT](LICENSE)
