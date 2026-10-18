import type { Runtime } from '../runtime.js';

/**
 * 给模型看的文字：按实际运行链生成，不列用户没配置的来源。
 * 每个宿主每轮都会注入工具描述，所以保持简短；怎么读结果放在 server instructions 里。
 */

const arrow = (names: string[]) => names.join(' → ');

export function searchDescription(rt: Runtime): string {
  const names = rt.providers.map(p => p.cfg.name);
  const status = rt.configError
    ? 'The server configuration is invalid, so every call fails until it is fixed (call web_search_status for details).'
    : names.length
      ? `Active chain: ${arrow(names)}.`
      : 'No search provider is configured yet, so every call fails until one is (call web_search_status for details).';
  return [
    'Search the web. Providers are tried in order and the first one that returns results wins.',
    status,
    'Each result has title and url, plus content (longer extract) or snippet (short summary) when available; fetch the url if you need more.',
    'Empty results: only a fallback_chain made entirely of no_results means nothing was found; otherwise isError is true and the search did not complete.',
  ].join(' ');
}

export function includeDomainsDescription(rt: Runtime): string {
  const groups = { native: [] as string[], single: [] as string[], none: [] as string[] };
  for (const p of rt.providers) groups[p.adapter.includeDomains].push(p.cfg.name);
  const parts: string[] = [];
  if (groups.native.length) parts.push(`${groups.native.join(', ')}: any number of domains`);
  if (groups.single.length) parts.push(`${groups.single.join(', ')}: one domain`);
  if (groups.none.length) parts.push(`${groups.none.join(', ')}: ignored`);
  const support = parts.length ? ` Support: ${parts.join('; ')}. Providers that can apply the filter are tried first.` : '';
  return `Only return results from these hostnames, e.g. ["docs.python.org"].${support}`;
}

export function providerParamDescription(rt: Runtime): string {
  const names = rt.providers.map(p => p.cfg.name);
  return `Debug only: query a single provider, bypassing failover and cache. One of: ${names.join(', ') || '(none configured)'}.`;
}

export const STATUS_DESCRIPTION =
  'Show search-failover health: which providers are active, blocked (with reason and remaining cooldown) or unconfigured, '
  + 'local request budgets, cache statistics, proxy, and configuration problems. Call it when web_search keeps failing. No arguments.';

/** server instructions：支持的宿主会注入系统提示，不装插件也能拿到 */
export const INSTRUCTIONS = [
  'search-failover provides web search with automatic failover across several search APIs.',
  'Use web_search whenever the task needs current or external information (docs, releases, news, error messages).',
  'Never conclude that nothing exists from empty results alone: read meta.fallback_chain.',
  'A chain made entirely of no_results means the search completed and found nothing; rephrase the query once.',
  'Any other outcome (rate_limited, quota_exhausted, auth_failure, timeout, network, server_error, budget_exhausted, skipped:*) means the search did not complete, and isError is true.',
  'auth_failure means that provider\'s API key was rejected: tell the user; failover continues with the other providers.',
  'meta.note explains degradations such as an ignored include_domains filter, a truncated query or trimmed content.',
  'When searches keep failing, call web_search_status to see which providers are blocked or misconfigured.',
].join('\n');
