# search-failover

[简体中文](README.md) | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/search-failover)](https://www.npmjs.com/package/search-failover) [![CI](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml/badge.svg)](https://github.com/crisweb1994/search-failover/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/node-%E2%89%A520.10-339933) ![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-6E43B8) ![license](https://img.shields.io/badge/license-MIT-blue)

**One `web_search` tool backed by 9 search sources.** When one runs out of quota, gets rate limited, times out or returns nothing, the next one takes over. Local hosts use stdio, remote platforms use Streamable HTTP, and the published package is a single file with no runtime dependencies.

[Quick start](#quick-start) · [Providers](#providers) · [How it works](#how-it-works) · [Hosts](#hosts) · [Configuration](#configuration) · [Network and proxy](#network-and-proxy) · [Tools](#tools-and-results) · [Limitations](#status-and-limitations)

## Why

An agent whose search tool is wired to a single API fails as soon as that API's monthly quota runs out, it gets rate limited, or the network hiccups. Worse, if the tool swallows the failure and returns an empty array, the agent concludes there is nothing online and answers from training data, confidently.

search-failover puts several search APIs behind one `web_search` tool and tries them in priority order; the first non-empty result wins. Every step is recorded in the result, so the agent can see which providers were tried, which were skipped, and why.

## What a result looks like

A search where Bocha is out of credit, Tavily is rate limited and Brave answers (upstream responses are simulated; the real output is compact JSON, formatted here):

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
    // …more results
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

`fallback_chain` lists every provider that did not answer: Bocha returned 403 (out of credit), recorded as `quota_exhausted` and left alone for a while; Tavily returned 429, recorded as `rate_limited` and retried after a cooldown; Brave answered and the search ended.

Read the same chain when results are empty. Only a chain made entirely of `no_results` means nothing was found; if any provider failed or was skipped, the MCP result has `isError: true`, meaning the search did not complete.

## Features

- **Automatic failover.** The default chain is Bocha → Tavily → Brave → Exa → SearXNG → DuckDuckGo; providers join only when their credentials are configured, and keyless DuckDuckGo is the last resort. A failure is never retried on the same provider; the next provider is the retry.
- **Classified by each provider's real signals.** Bocha's 403 means out of credit, Brave's invalid key is a 422 (not 401), a 429 can mean a per-second limit or an exhausted monthly quota, and DuckDuckGo signals rate limiting with a 202 and an anomaly page. Each adapter maps these to 8 error classes with their own cooldown policies.
- **Results written for the model.** The full decision chain is included; "found nothing" and "did not search" are distinguished with MCP `isError`; with `include_domains`, providers that can apply the filter are tried first, and `note` says so when the provider that answered could not; the tool description lists only providers that are actually available.
- **One configuration for every host.** Credentials and provider order can be set entirely through environment variables or in `~/.config/search-failover/config.json`, so each host only needs `npx -y search-failover`. `${...}` templates a host failed to expand are never mistaken for keys.
- **Local and remote.** stdio for local hosts such as Claude Code, Cursor and Codex; `--http` starts a Streamable HTTP server for platforms that only support remote MCP, with quota counters, cooldowns and cache shared by every client.
- **No surprise bills.** Paid or one-off-credit providers (Zhipu, Qianfan, Serper) never join the chain just because a key is set; they must be listed explicitly. Most providers carry local request budgets and rate limits that hold under concurrency.
- **Proxy support.** Honors `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` (Node's built-in fetch ignores them).
- **Small and auditable.** The package is a single esbuild bundle, so a cold `npx` start downloads one package; no database, no background jobs, state lives in process memory, and all logs go to stderr.

## Quick start

Requires Node ≥ 20.10. No install needed; `npx` runs it.

**1. Credentials.** Configure as many as you like; with none at all only DuckDuckGo is available (it needs a proxy from mainland China, see [Network and proxy](#network-and-proxy)). The user-level config file is shared by every host:

```jsonc
// ~/.config/search-failover/config.json (Windows: %APPDATA%\search-failover\config.json)
{
  "credentials": {
    "BOCHA_API_KEY": "...",
    "TAVILY_API_KEY": "..."
  }
}
```

Consider `chmod 600` on that file. Environment variables work too (names in [Providers](#providers)) and take precedence.

**2. Add it to a host.** For example Claude Code:

```bash
claude mcp add search-failover -- npx -y search-failover
```

See [Hosts](#hosts) for Codex, Cursor, ZCode, VS Code, OpenCode, Claude Desktop and others.

**3. Check status.** Ask the agent to call `web_search_status`: it shows whether each provider is `active`, `unconfigured` (no credentials found), `disabled` (not in the chain) or `blocked`, plus where the config file is and whether it has errors.

## Providers

<!-- generated:providers -->
| Provider | Variable | In default chain | Local budget | `include_domains` |
| --- | --- | --- | --- | --- |
| Bocha 博查 | `BOCHA_API_KEY` | yes | 1000/month, resets on day 1 | not supported |
| Zhipu 智谱 | `ZHIPU_API_KEY` | no (opt-in, list it explicitly) | unlimited | one domain |
| Tavily | `TAVILY_API_KEY` | yes | 1000/month, resets on day 2 | multiple domains |
| Baidu Qianfan 百度千帆 | `QIANFAN_API_KEY` | no (opt-in, list it explicitly) | 1500/month, resets on day 1 | multiple domains |
| Brave Search | `BRAVE_API_KEY` | yes | 1000/month, resets on day 15 | one domain |
| Serper | `SERPER_API_KEY` | no (opt-in, list it explicitly) | 2500 in total | one domain |
| Exa | `EXA_API_KEY` | yes | 800/month, resets on day 1 | multiple domains |
| SearXNG (self-hosted) | `SEARXNG_URL` (instance URL) | yes | unlimited | one domain |
| DuckDuckGo | none needed | yes | unlimited | one domain |
<!-- /generated:providers -->

- The table is in default priority order and is generated from the provider registry by `npm run plugin:sync`. The default chain contains only providers marked "yes" whose credentials are configured.
- Zhipu, Qianfan and Serper are paid or one-off credits: **a key alone does not add them to the chain**; list them in `SEARCH_FAILOVER_PROVIDERS` or in the config file's `providers` (see [Configuration](#configuration)).
- "Local budget" is the gateway's own conservative counter to avoid unnecessary requests. It is not your account balance and does not guarantee staying within a free tier. Pricing references (2026-10-04): [Brave](https://api-dashboard.search.brave.com/documentation/pricing)'s 1,000 is derived from monthly credits; [Exa](https://exa.ai/pricing) resets credits monthly and 800 is only a local cap; Zhipu charges per call (included in the GLM Coding Plan); Qianfan has 1,500 free calls per month, then pay as you go; Serper uses one-off credits, tiered pricing not yet verified.
- SearXNG needs a self-hosted instance with `json` added to `search.formats` in its `settings.yml`; otherwise the API returns 403.
- DuckDuckGo works by scraping its HTML page: no key, but subject to anti-bot measures; unreachable from mainland China without a proxy.

## How it works

```text
web_search(query)
 ├─ cache hit      → return immediately, no upstream request
 └─ cache miss → try providers in priority order; skip those cooling down, out of local budget, or unable to get a rate-limit slot in time
      Bocha    403 out of credit → blocked until recovery, next
      Tavily   429 rate limited  → cooldown, next
      Brave    results           → done, return results and fallback_chain
      Exa / DuckDuckGo …         (never reached, never requested)
```

The first non-empty result wins. No error is retried on the same provider: **the next provider is the retry**. Each provider tracks only three things: blocked until when, why, and how many consecutive failures; the block lifts automatically and the next request is the probe.

With `include_domains`, providers that can apply the filter go first (multi-domain support, or single-domain support when one domain is given); providers that cannot are kept as a last resort.

How each error class is handled:

| Class | Typical signal | Handling |
| --- | --- | --- |
| `rate_limited` | 429; DuckDuckGo anomaly page | Cool down for the upstream wait time, else 60 s, capped at 1 h (6 h for DuckDuckGo) |
| `quota_exhausted` | Bocha 403; Exa, Serper 402; Tavily 432/433; Brave 429 + `QUOTA_LIMITED`; Zhipu 429 + 1113 | Block until the upstream recovery time; otherwise wait `quota_retry_s` (default 6 h) |
| `auth_failure` | 401; Brave 422 + `SUBSCRIPTION_TOKEN_INVALID` | Remove the provider until restart |
| `timeout` / `network` | Timeout, connection failure (`detail` carries the real cause: ENOTFOUND, ECONNREFUSED, certificate errors…) | Cool down from 30 s, doubling on consecutive failures, capped at 1 h |
| `server_error` | 5xx; unparsable response; every SearXNG engine failed | Cool down from 60 s, doubling, capped at 1 h |
| `request_error` | 400/422 parameter errors | Do not block, move on |
| `no_results` | Valid empty result (Bocha and Brave omit their result field when there are no results; that counts as empty too) | No penalty, move on |

- **Total budget.** A search takes at most 30 s, each provider at most 10 s. Providers never reached are recorded as `skipped:budget_exhausted`; a provider that was requested but outlasted the total budget is recorded as `budget_exhausted`. Neither counts against the provider. When the host cancels, in-flight requests are aborted and failover stops.
- **Two independent clocks.** An upstream recovery time is used when given, otherwise `quota_retry_s`; the local `reset_day` only resets the local counter. When a cooldown ends, the next search may try again; the gateway never probes in the background.
- **Local request budget.** Every approved upstream request counts, including upstream errors and cancellation after approval; cache hits and cancellation while queued do not. When the count reaches `quota.limit`, the provider is recorded as `skipped:quota_local`. `monthly` resets by local time zone and `reset_day`; `one_time` accumulates for the process lifetime. The check and the increment happen in one synchronous step, so concurrent requests cannot overshoot.

<details>
<summary>Caching and fetch size</summary>

- The cache key is the normalized query (case and extra whitespace ignored), `max_results`, `freshness` and `include_domains`. Default TTL is 1 hour, 15 minutes for `freshness=day`; tune with `cache.ttl_s` / `cache.ttl_fresh_s`.
- `use_cache=false` or a disabled cache skips both reads and writes. Cache hits restate the winning provider's degradation notes.
- Each provider fetches `min(max_results, provider limit)`, no prefetch. Different counts are cached separately; short non-empty results are cached too.
- `freshness` is applied by each provider with its own date semantics; Qianfan ignores `day` and says so in `note`.

</details>

## Hosts

| Host | How |
| --- | --- |
| Claude Code | `claude mcp add`, or `.mcp.json` |
| Codex | Plugin marketplace, or `codex mcp add` |
| Cursor | MCP config (official marketplace listing under review) |
| ZCode | Plugin marketplace, or MCP config |
| VS Code (Copilot) | `.vscode/mcp.json` |
| OpenCode | MCP config (written from the official docs, not yet tested in the client) |
| Claude Desktop, Windsurf, Cline, Cherry Studio, … | Generic `mcpServers` config |
| Platforms that only support remote MCP (web clients, Dify / n8n style workflow tools) | [HTTP mode](#http-mode-remote-platforms) |

The repository is packaged per [Agent Plugins 1.0](https://agent-plugins.org) (see `plugin/`); marketplace manifests for Codex / Cursor / ZCode live at the repository root.

> [!IMPORTANT]
> **Things that apply to every host:**
> - **Put credentials wherever is convenient; the user-level config file is recommended.** Environment variables win, then `credentials` in `~/.config/search-failover/config.json`, so host configs need no keys.
> - **GUI hosts launched from the Dock or Start menu (e.g. Claude Desktop) do not see variables exported in your shell**, and often cannot find an `npx` installed through nvm, Volta or fnm. On `spawn npx ENOENT`, use the absolute path of `npx` (`which npx`) as `command` and keep credentials in the config file.
> - **Windows:** if the host cannot find `npx`, use `"command": "cmd"` and prepend `"/c", "npx"` to `args`.
> - **A key alone does not enable a provider.** Zhipu, Qianfan and Serper must be listed in `SEARCH_FAILOVER_PROVIDERS` or in the config file's `providers`.
> - `${...}` templates a host did not expand are treated as unset and reported in `config.warnings` of `web_search_status`.

<details>
<summary>Claude Code</summary>

```bash
claude mcp add search-failover -- npx -y search-failover
# credentials or provider order for this host only:
claude mcp add search-failover -e TAVILY_API_KEY=... -e SEARCH_FAILOVER_PROVIDERS=tavily,brave,duckduckgo -- npx -y search-failover
```

Add `--scope user` to enable it for all projects. To use HTTP mode: `claude mcp add --transport http search-failover http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"`.

</details>

<details>
<summary>Codex</summary>

**Plugin marketplace** (CLI ≥ 0.117):

```bash
codex plugin marketplace add crisweb1994/search-failover
```

Then install search-failover from the plugin directory in the ChatGPT desktop app / Codex. Put credentials in the user-level config file.

**MCP config**:

```bash
codex mcp add search-failover -- npx -y search-failover
```

Or edit `~/.codex/config.toml`:

```toml
[mcp_servers.search-failover]
command = "npx"
args = ["-y", "search-failover"]
startup_timeout_sec = 30   # the first npx download can exceed the 10 s default

[mcp_servers.search-failover.env]
TAVILY_API_KEY = "..."
```

</details>

<details>
<summary>Cursor</summary>

Global `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

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

`${env:NAME}` is Cursor's variable interpolation, so keys stay in your shell environment. Drop the `env` block entirely when credentials live in the user-level config file. A native Cursor plugin manifest (`.cursor-plugin/`) is included and can be added locally until the official listing is approved.

</details>

<details>
<summary>ZCode</summary>

**Plugin marketplace**: Discover → `+` → paste `https://github.com/crisweb1994/search-failover` → install. The plugin's settings have two optional fields: `config_path` (absolute path of a config file; the user-level file is used by default) and `providers` (provider order, e.g. `bocha,tavily,duckduckgo`). Put credentials in the user-level config file.

**MCP config**: user-level `~/.zcode/cli/config.json` (project-level `<repo>/.zcode/config.json`); note the nested `mcp.servers`:

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

ZCode's MCP schema is strict: `command` must be a string, the environment field must be named `env`, a server with any unknown field is silently dropped, and `${...}` templates are not expanded.

</details>

<details>
<summary>VS Code (Copilot)</summary>

`.vscode/mcp.json` (the top-level key is `servers`):

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

`opencode.json`:

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

Unlike other hosts, `command` is an **array** and the environment field is **`environment`**. Written from the OpenCode docs; not yet tested in the client.

</details>

<details>
<summary>Claude Desktop, Windsurf, Cline, Cherry Studio, …</summary>

Hosts using the generic `mcpServers` format:

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

After a global install (`npm install -g search-failover`) you can use `"command": "search-failover"`. To run from source, use `"command": "node"` with the absolute path of `dist/index.js` in `args`.

</details>

### HTTP mode (remote platforms)

```bash
SEARCH_FAILOVER_HTTP_TOKEN=$(openssl rand -hex 24) npx -y search-failover --http --port 8787
# MCP endpoint: http://127.0.0.1:8787/mcp   health check: /healthz
```

- Stateless Streamable HTTP: every request is handled independently and all clients share one set of quota counters, cooldowns and cache, so several hosts can use it without double counting.
- Listens on `127.0.0.1` by default. Any other address (`--host 0.0.0.0`) requires `SEARCH_FAILOVER_HTTP_TOKEN`, otherwise the server refuses to start; put a public deployment behind an HTTPS reverse proxy.
- Clients authenticate with `Authorization: Bearer <token>`. Platforms that only accept a URL can use `https://your.host/mcp?token=<token>`, but query strings may end up in proxy logs.
- Without a token, only loopback Host / Origin values are accepted, so web pages cannot reach your local server through DNS rebinding.

## Configuration

Everything works without configuration. When you need to adjust, use either or both of:

**Environment variables** (every host supports them; good for simple setups):

| Variable | Purpose |
| --- | --- |
| `BOCHA_API_KEY` etc. | Provider credentials, see [Providers](#providers) |
| `SEARCH_FAILOVER_PROVIDERS` | The chain in priority order, comma separated, e.g. `tavily,brave,duckduckgo`; listed opt-in providers are enabled |
| `SEARCH_FAILOVER_CONFIG` | Config file path; defaults to the user-level file |
| `SEARCH_FAILOVER_HTTP_TOKEN` | Token for HTTP mode |
| `SEARCH_FAILOVER_DEBUG=1` | Expose the debug parameter `provider` (query a single provider) to the model |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Outbound proxy, see [Network and proxy](#network-and-proxy) |
| `LOG` | Log level: `error` / `warn` / `info` / `debug` (stderr; `debug` logs every failover step) |

**Config file**: `SEARCH_FAILOVER_CONFIG` first (if set, the file must exist and be valid), otherwise the user-level file `$XDG_CONFIG_HOME/search-failover/config.json`, by default `~/.config/search-failover/config.json`, or `%APPDATA%\search-failover\config.json` on Windows. **The current directory is never read**: hosts start servers in different working directories, and a config file inside someone else's repository must not be able to enable paid providers on your behalf.

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

Rules:

- **The order of `providers` is the priority**, and listing a provider enables it (`"enabled": false` disables it temporarily). Omit `providers` for the default chain; `[]` means an empty chain.
- When `SEARCH_FAILOVER_PROVIDERS` is set, it decides the list and order; tuning fields for those providers in the config file still apply.
- `credentials` keys are environment variable names; a set environment variable of the same name wins.
- Omitted fields inherit the provider's defaults (rate limits, quota, cooldown). `quota` is merged field by field when the type is unchanged and replaced when the type changes, e.g. `{ "type": "unbounded" }` removes the local budget.
- Unknown or duplicate provider names, unknown fields (including typos such as `limt` for `limit`) and invalid values are configuration errors. **On a configuration error the server still starts but runs no providers**: every search returns `config_error` with the location, also shown by `web_search_status`, so the cause is visible in any host's conversation.

Fields:

| Field | Meaning | Default |
| --- | --- | --- |
| `providers[].name` | `bocha` `zhipu` `tavily` `qianfan` `brave` `serper` `exa` `searxng` `duckduckgo` | required |
| `providers[].enabled` | `false` disables it temporarily | `true` |
| `providers[].quota` | Local request budget: `type` (`monthly` / `one_time` / `unbounded`), `limit`, `reset_day` (1–31) | per provider, see [Providers](#providers) |
| `providers[].quota_retry_s` | Wait in seconds after a quota error without an upstream recovery time; `0` disables that cooldown | `21600` |
| `providers[].local_qps` / `min_interval_ms` | Local rate limit | 1 QPS for Brave, Qianfan, Serper; 2 s interval for DuckDuckGo |
| `providers[].cooldown_max_s` | Per-provider cooldown cap | global value; 21600 for DuckDuckGo |
| `credentials.<ENV_NAME>` | Credential (key, or SearXNG instance URL) | – |
| `defaults.timeout_ms` | Per-provider request timeout | `10000` |
| `defaults.total_budget_ms` | Total budget per search | `30000` |
| `defaults.cooldown_default_s` / `cooldown_max_s` | Default rate-limit cooldown / cooldown cap (s) | `60` / `3600` |
| `defaults.max_output_chars` | Total character budget for result text (`content`/`snippet`) per response | `12000` |
| `cache.enabled` | Enable the cache | `true` |
| `cache.ttl_s` / `ttl_fresh_s` | Cache TTL, the latter for `freshness=day` | `3600` / `900` |
| `cache.max_entries` | Cache size limit | `512` |

## Network and proxy

- With `HTTPS_PROXY` (or `HTTP_PROXY`) set, all outbound requests go through the proxy; `NO_PROXY` lists direct destinations as usual. When `NO_PROXY` is unset, `localhost`, `127.0.0.1` and `::1` stay direct so a local SearXNG keeps working. The proxy in use is shown by `web_search_status` (credentials redacted).
- The gateway has to do this itself: Node's built-in fetch ignores these variables (still a direct connection on Node 22 with `HTTPS_PROXY` set).
- **Mainland China:** DuckDuckGo is unreachable, so the zero-config setup needs a proxy there; Tavily, Brave and Exa often do too. Without a proxy, Bocha, Zhipu and Qianfan are domestic services, and a self-hosted SearXNG can serve as the keyless fallback.

## Tools and results

### `web_search`

| Parameter | Default | Description |
| --- | --- | --- |
| `query` | required | Search query. Truncated to 400 characters; Zhipu and Qianfan truncate further and say so in `note` |
| `max_results` | 8 | 1–20; out-of-range values and numeric strings are adjusted automatically |
| `freshness` | – | `day` / `week` / `month` / `year` |
| `include_domains` | – | Only return results from these hostnames; forms like `https://docs.rs/x`, `site:docs.rs` and `*.docs.rs` are normalized to `docs.rs` |
| `use_cache` | true | Read and write the cache |

The debug parameter `provider` (query a single provider) only appears with `SEARCH_FAILOVER_DEBUG=1`. The tool description is generated from the providers currently available.

Returns `results[]` and `meta`. Every result has `title` and `url`; the text is in `content` (when the source gives a longer extract) or `snippet` (short summary only), never both, sometimes neither. When the combined text exceeds `defaults.max_output_chars`, longer entries are shortened proportionally and `note` says so (hosts generally cap tool output, e.g. 25k tokens by default in Claude Code). `meta` contains `provider_used`, the full `fallback_chain`, `cache_hit`, `elapsed_ms` and an optional `note`.

Reading `fallback_chain`:

| outcome | Meaning |
| --- | --- |
| `no_results` | The provider returned a valid empty result |
| `rate_limited` `quota_exhausted` `auth_failure` `timeout` `network` `server_error` `request_error` | The provider failed; handling in [How it works](#how-it-works) |
| `budget_exhausted` | The request was sent, but the search's total budget ran out first |
| `skipped:<reason>` | The provider was not requested this time: still cooling down (`auth_failure` has detail `until_restart`), `quota_local` (local budget used up), `local_rate` (no rate-limit slot in time), `budget_exhausted` (total budget already used) |
| `config_error` / `no_provider` / `internal_error` (provider `gateway`) | Configuration error / no available provider / gateway bug |

Empty results: a non-empty chain made entirely of `no_results` is a normal empty search; any failure or skip, or no runnable provider, gives `isError: true`.

### `web_search_status`

No arguments. Returns each provider's state, the environment variable that configures it, block reason and remaining time, consecutive failures, local usage (warning at 90%), plus the config file location and errors, proxy and cache statistics. Excerpt:

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

### Troubleshooting

| In `web_search_status` | Meaning | What to do |
| --- | --- | --- |
| `config.error` is set | The config file or an environment variable is invalid; no search runs | Fix the reported location, restart the host |
| `config.warnings` mentions an unexpanded template | The host did not expand `${...}`; the value was ignored | Use the real value, or move it to the config file |
| `unconfigured` | No credentials found for this provider (`credential_env`) | Set the environment variable or `credentials` in the config file, restart the host |
| `disabled` | Credentials exist but the provider is not in the chain (opt-in providers are not by default) | Add it to `SEARCH_FAILOVER_PROVIDERS` or `providers` |
| `disabled(auth_failure)` | The key was rejected; removed until restart | Replace the key, restart the host |
| `blocked(<reason>, Ns left)` | Cooling down | Wait, or check `last_error` |
| `blocked(quota_local)` | Local request budget used up | Raise `quota.limit`, or wait for the next period |
| `active` | Available | – |

## Status and limitations

- **State lives in process memory.** Counters, rate limits, cooldowns and cache reset on restart. In stdio mode each host runs its own process and nothing is shared; use HTTP mode to let several hosts share one process. Counters do not include usage of the same key by other applications.
- **Concurrent identical queries are not coalesced.** Two identical requests arriving together each hit upstream once.
- **Results from several providers are not merged.** The first non-empty result wins; this is a failover gateway, not a metasearch engine.
- **Some providers are not yet calibrated with real keys.** Contract tests for Zhipu, Qianfan, Serper and SearXNG use responses built from official docs; the "no results" response shapes for Bocha and Brave are inferred from the official implementation and response model. `scripts/probe.mts` captures real responses (including a query that cannot match anything); if you have keys, please run it and post the redacted output in an issue.
- **DuckDuckGo works by scraping HTML.** No key, but subject to network conditions and anti-bot measures; a page redesign can break it, and an unrecognized page structure is reported as an error, never as an empty result.
- **Host compatibility.** The OpenCode and VS Code configs are written from official docs and not yet tested in those clients; the official Cursor marketplace listing is under review. HTTP mode is tested locally with the MCP SDK client but not yet against each platform.

## Development and release

```bash
npm run dev         # run locally with tsx (stdio); add -- --http for HTTP mode
npm test            # unit / contract / router integration / stdio and HTTP e2e
npm run typecheck   # tsc --noEmit
npm run build       # esbuild single-file bundle at dist/index.js
node scripts/runtime-smoke.mjs dist/index.js   # stdio smoke test of the build (mocked upstream)
```

The repository's `.cursor/mcp.json` and `.zcode/config.json` point at the local build (run `npm run build` first), so opening the repo in Cursor / ZCode uses your working copy; ZCode needs the repository root as its working directory.

Adding a provider: create an adapter in `src/providers/` exporting a `definition` with its credential variable, defaults and capabilities, add one line to `src/providers/registry.ts`, write contract tests, then run `npm run plugin:sync` to regenerate the Cursor plugin variables and the provider tables above. The process is probe-first: `npx tsx scripts/probe.mts <provider>` captures redacted snapshots of a normal query, a query that cannot match anything, a bad key and out-of-range parameters with a real key, and the contract tests are calibrated against them.

Plugin manifests: `npm run plugin:check` (structure, generated content and pinned version; run by `prepublishOnly`), `npm run plugin:sync` (regenerate Cursor variables and provider tables), `node scripts/plugin-sync.mjs --published` (confirm the pinned version is published on npm; run in CI). The pinned version is updated by the release workflow; no manual edits needed.

The release smoke test launches the real published package exactly as the plugins do and runs initialize → tools/list → status → a real search: `node scripts/smoke-stdio.mjs`, with `--env KEY=V`, `--config /abs/path/config.json`, `--command node -- dist/index.js` (local build).

<details>
<summary>Release process (automated)</summary>

Versions are decided by [release-please](https://github.com/googleapis/release-please) from [Conventional Commits](https://www.conventionalcommits.org/); nobody edits the version by hand:

1. **Commit convention.** PRs are squash-merged, so the PR title becomes the commit on main; the `PR title` workflow checks its format. `fix:` bumps patch, `feat:` bumps minor, `feat!:` or a `BREAKING CHANGE:` footer bumps major (minor before 1.0). `docs:`, `chore:`, `ci:`, `test:` and similar do not trigger a release.
2. **Release PR.** On every merge to main, release-please opens or updates a `chore: release x.y.z` PR that bumps `package.json`, the lockfile and the CHANGELOG. Merge it when you want to release.
3. **Automatic publish.** After the release PR is merged, the `Release` workflow creates the tag and GitHub Release → publishes to npm with OIDC trusted publishing → waits until the version is installable, then runs `plugin-sync --to x.y.z` and pushes the plugin manifest pins to main.

Marketplaces read manifests from the default branch, so the manifests always pin the latest *published* version: they may lag behind `package.json` (between merging the release PR and the npm publish finishing) but never run ahead. CI's `--published` check and `plugin:check` reject changes that break either rule.

Repository settings needed:

- Allow squash merging only, with the PR title as the default commit message.
- Add a `RELEASE_TOKEN` secret (GitHub App token or fine-grained PAT with contents and pull-requests write access). Release PRs and commits created with the default `GITHUB_TOKEN` do not trigger CI, and if main is protected the token also needs permission to push the manifest commit.
- npm Trusted Publisher is bound to `release.yml` and the `release` environment; do not rename the workflow file.

</details>

## Feedback

If a search API behaves unexpectedly, please open an [issue](https://github.com/crisweb1994/search-failover/issues), ideally with a redacted response body; it can become a contract test as is.

## License

[MIT](LICENSE)
