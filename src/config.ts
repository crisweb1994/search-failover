import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { log } from './logger.js';
import { defaultProviderConfigs } from './providers/registry.js';

const quotaSchema = z.object({
  type: z.enum(['monthly', 'one_time', 'unbounded']).default('unbounded'),
  limit: z.number().int().nonnegative().optional(),
  reset_day: z.number().int().min(1).max(31).optional(),
  quota_retry_s: z.number().finite().nonnegative().default(21600),
});

export const providerSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  quota: quotaSchema.default({}),
  /** 本地 QPS 限制（Brave 默认保守设为 1 QPS），请求间隔不足时本地补齐等待 */
  local_qps: z.number().finite().positive().optional(),
  /** 请求最小间隔毫秒（DDG 礼貌间隔） */
  min_interval_ms: z.number().int().nonnegative().optional(),
  /** 该源冷却时长上限覆盖（秒）；DDG 被封需要 6h */
  cooldown_max_s: z.number().finite().nonnegative().optional(),
  /**
   * 取数策略（D12）：cache_fill=一次取足 min(store_size, maxCount) 喂缓存（按请求计费源）；
   * as_requested=只取 maxResults（按结果数计费源，如 Exa）。
   */
  fetch_policy: z.enum(['cache_fill', 'as_requested']).default('cache_fill'),
});

const defaultsSchema = z.object({
  max_results: z.number().int().min(1).max(20).default(8),
  timeout_ms: z.number().int().positive().default(10000),
  total_budget_ms: z.number().int().positive().default(30000),
  cooldown_default_s: z.number().finite().nonnegative().default(60),
  cooldown_max_s: z.number().finite().nonnegative().default(3600),
});

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  store_size: z.number().int().min(1).max(20).default(20),
  ttl_s: z.number().finite().nonnegative().default(3600),
  ttl_fresh_s: z.number().finite().nonnegative().default(900),
  max_entries: z.number().int().nonnegative().default(512),
});

export const configSchema = z.object({
  providers: z.array(providerSchema),
  defaults: defaultsSchema.default({}),
  cache: cacheSchema.default({}),
});

export type ProviderCfg = z.infer<typeof providerSchema>;
export type AppConfig = z.infer<typeof configSchema>;

/** 默认配置由注册表生成（D15：名单单一事实来源；opt-in 源 enabled=false） */
export function defaultProviders(): ProviderCfg[] {
  return defaultProviderConfigs();
}

/** 名单由用户决定；仅继承所列来源的默认字段，不做递归合并。 */
export function parseConfig(input: unknown): AppConfig {
  const raw = z.object({ providers: z.array(z.object({
    name: z.string(), quota: quotaSchema.partial().optional(),
  }).passthrough()).optional() }).passthrough().parse(input);
  const defaults = defaultProviders();
  const seen = new Set<string>();
  const providers = raw.providers?.map(p => {
    const base = defaults.find(d => d.name === p.name);
    if (!base) throw new Error(`未知来源: ${p.name}`);
    if (seen.has(p.name)) throw new Error(`重复来源: ${p.name}`);
    seen.add(p.name);
    const quota = p.quota?.type && p.quota.type !== base.quota.type
      ? p.quota : { ...base.quota, ...p.quota };
    return { ...base, ...p, quota };
  }) ?? defaults;
  return configSchema.parse({ ...raw, providers });
}

function die(message: string): never {
  log.error(`配置错误: ${message}`);
  process.exit(1);
}

/**
 * 加载顺序：$SEARCH_FAILOVER_CONFIG 指定路径（必须存在且合法，否则退出）→
 * cwd 的 search-failover.json（不存在则全默认）→ 全默认值。
 * key 一律走环境变量，不落盘。
 */
export function loadConfig(): AppConfig {
  let raw: Record<string, unknown> = {};
  const explicit = process.env['SEARCH_FAILOVER_CONFIG'];
  const defaultPath = 'search-failover.json';
  const path = explicit ?? defaultPath;

  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (explicit || !notFound) {
      die(`无法读取 ${path}: ${String((err as Error).message)}`);
    }
    // 默认路径不存在 → 全默认
  }

  try {
    return parseConfig(raw);
  } catch (err) {
    die(String(err instanceof Error ? err.message : err));
  }
}
