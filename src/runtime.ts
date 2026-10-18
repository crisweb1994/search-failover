import { cleanValue, readEnv, unexpandedEnv, type Env } from './env.js';
import type { AppConfig, LoadedConfig } from './config.js';
import type { NetworkInfo } from './net.js';
import { CREDENTIAL_ENVS, PROVIDERS, REGISTRY } from './providers/registry.js';
import type { ProviderDefinition } from './providers/types.js';
import type { ProviderEntry } from './router.js';
import { GatewayState } from './state.js';
import { ResultCache } from './cache.js';

/** 进程内共享的一切：stdio 模式一个宿主一份；HTTP 模式所有客户端共用一份（计数、冷却、缓存都共享） */
export interface Runtime {
  config: AppConfig;
  /** 可运行的链：在名单内且凭据齐全，已按优先级排列 */
  providers: ProviderEntry[];
  /** 凭据齐全（或不需要凭据）的来源名，含不在链里的 */
  configured: ReadonlySet<string>;
  state: GatewayState;
  cache: ResultCache;
  configSource?: string;
  configError?: string;
  /** 环境里可疑的配置（未展开的模板等），status 原样展示 */
  warnings: string[];
  network: NetworkInfo;
  /** SEARCH_FAILOVER_DEBUG=1：向模型暴露 provider 参数 */
  debug: boolean;
}

/** 环境变量优先，其次是配置文件 credentials（键同样是环境变量名） */
export function resolveCredential(def: ProviderDefinition, fileCredentials: Record<string, string>, env: Env): string | undefined {
  if (!def.credentialEnv) return undefined;
  return readEnv(def.credentialEnv, env) ?? cleanValue(fileCredentials[def.credentialEnv]);
}

const WATCHED_ENV = [
  ...CREDENTIAL_ENVS, 'SEARCH_FAILOVER_CONFIG', 'SEARCH_FAILOVER_PROVIDERS', 'SEARCH_FAILOVER_HTTP_TOKEN',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
];

export function buildRuntime(loaded: LoadedConfig, options: { env?: Env; network?: NetworkInfo } = {}): Runtime {
  const env = options.env ?? process.env;
  const { config } = loaded;
  const credentials = new Map<string, string | undefined>();
  const configured = new Set<string>();
  for (const def of PROVIDERS) {
    const credential = resolveCredential(def, config.credentials, env);
    credentials.set(def.adapter.name, credential);
    if (!def.credentialEnv || credential) configured.add(def.adapter.name);
  }
  const providers = config.providers
    .filter(cfg => configured.has(cfg.name))
    .map(cfg => ({ cfg, adapter: REGISTRY[cfg.name]!.adapter, credential: credentials.get(cfg.name) }));
  const warnings = unexpandedEnv(WATCHED_ENV, env)
    .map(name => `${name} looks like an unexpanded template (${env[name]!.trim()}); treated as unset`);
  if (options.network?.error) warnings.push(options.network.error);
  return {
    config,
    providers,
    configured,
    state: new GatewayState(),
    cache: new ResultCache(config.cache),
    configSource: loaded.source,
    configError: loaded.error,
    warnings,
    network: options.network ?? {},
    debug: /^(1|true|yes)$/i.test(readEnv('SEARCH_FAILOVER_DEBUG', env) ?? ''),
  };
}
