import type { ProviderCfg } from '../config.js';
import { PROVIDER_NAMES, REGISTRY } from '../providers/registry.js';
import type { Runtime } from '../runtime.js';
import { VERSION } from '../version.js';

function quotaProfile(cfg: ProviderCfg): string {
  if (cfg.quota.type === 'monthly') return `monthly:${cfg.quota.limit ?? '?'}@day${cfg.quota.reset_day ?? 1}`;
  if (cfg.quota.type === 'one_time') return cfg.quota.limit === undefined ? 'one_time' : `one_time:${cfg.quota.limit}`;
  return 'unbounded';
}

/** 运行链里的来源按优先级在前，其余来源随后（状态为 disabled 或 unconfigured），配置一次就能看全 */
export function makeStatusHandler(rt: Runtime) {
  return async () => {
    const chain = rt.config.providers.map(cfg => cfg.name);
    const providers = [...chain, ...PROVIDER_NAMES.filter(name => !chain.includes(name))].map(name => {
      const cfg = rt.config.providers.find(p => p.name === name);
      const configured = rt.configured.has(name);
      const base = { name, in_chain: cfg !== undefined, credential_env: REGISTRY[name]?.credentialEnv ?? undefined };
      if (!cfg) return { ...base, state: configured ? 'disabled' : 'unconfigured' };
      if (!configured) return { ...base, state: 'unconfigured' };

      const blocked = rt.state.checkBlocked(name);
      const used = rt.state.used(name, cfg);
      let state = 'active';
      if (blocked?.reason === 'auth_failure') state = 'disabled(auth_failure)';
      else if (blocked) state = `blocked(${blocked.reason}, ${blocked.remainS}s left)`;
      else if (cfg.quota.type !== 'unbounded' && cfg.quota.limit !== undefined && used >= cfg.quota.limit) state = 'blocked(quota_local)';
      return {
        ...base,
        state,
        fail_streak: rt.state.failStreak(name),
        used_requests: used,
        quota_profile: quotaProfile(cfg),
        quota_warning: rt.state.quotaWarning(name, cfg),
        last_error: rt.state.lastError(name),
      };
    });

    const payload = {
      version: VERSION,
      providers,
      config: { source: rt.configSource ?? null, error: rt.configError ?? null, warnings: rt.warnings },
      network: { proxy: rt.network.proxy ?? null },
      cache: { entries: rt.cache.size, hits: rt.cache.hits, misses: rt.cache.misses },
      uptime_s: Math.floor((Date.now() - rt.state.startedAt) / 1000),
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
  };
}
