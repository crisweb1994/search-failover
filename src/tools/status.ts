import { apiKeyFor } from '../config.js';
import type { ResultCache } from '../cache.js';
import type { GatewayState } from '../state.js';
import type { ToolDeps } from './search.js';

function quotaProfile(p: { quota: { type: string; limit?: number; reset_day?: number } }): string {
  if (p.quota.type === 'monthly') return `monthly:${p.quota.limit ?? '?'}@day${p.quota.reset_day ?? 1}`;
  if (p.quota.type === 'one_time') return 'one_time';
  return 'unbounded';
}

export function makeStatusHandler(deps: ToolDeps) {
  return async () => {
    const providers = deps.allProviders.map(cfg => {
      const configured = cfg.name === 'duckduckgo' || !!apiKeyFor(cfg.name);
      const blocked = deps.state.checkBlocked(cfg.name);
      let state: string;
      if (!configured) state = 'unconfigured';
      else if (blocked?.reason === 'auth_failure') state = 'disabled(auth_failure)';
      else if (blocked) state = `blocked(${blocked.reason}, 剩${blocked.remainS}s)`;
      else state = 'active';

      return {
        name: cfg.name,
        state,
        fail_streak: deps.state.failStreak(cfg.name),
        used_this_month: deps.state.used(cfg.name),
        quota_profile: quotaProfile(cfg),
        quota_warning: deps.state.quotaWarning(cfg.name, cfg),
        last_error: deps.state.lastError(cfg.name),
      };
    });

    const payload = {
      providers,
      cache: {
        entries: deps.cache.size,
        hits: deps.cache.hits,
        misses: deps.cache.misses,
      },
      uptime_s: Math.floor((Date.now() - deps.state.startedAt) / 1000),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  };
}
