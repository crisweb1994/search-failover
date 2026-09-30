import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { log } from './logger.js';

/** 每个源 API key 的环境变量名；duckduckgo 不需要 key */
export const ENV_KEYS: Record<string, string> = {
  bocha: 'BOCHA_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_API_KEY',
  exa: 'EXA_API_KEY',
  duckduckgo: '',
};

export function apiKeyFor(name: string): string | undefined {
  const envKey = ENV_KEYS[name];
  if (!envKey) return undefined;
  return process.env[envKey] || undefined;
}

const quotaSchema = z.object({
  type: z.enum(['monthly', 'one_time', 'unbounded']).default('unbounded'),
  limit: z.number().optional(),
  reset_day: z.number().int().min(1).max(31).optional(),
  quota_retry_s: z.number().default(21600),
});

export const providerSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  quota: quotaSchema.default({}),
  /** 本地 QPS 限制（Brave 免费档 1 QPS），请求间隔不足时本地补齐等待 */
  local_qps: z.number().optional(),
  /** 请求最小间隔毫秒（DDG 礼貌间隔） */
  min_interval_ms: z.number().optional(),
  /** 该源冷却时长上限覆盖（秒）；DDG 被封需要 6h */
  cooldown_max_s: z.number().optional(),
});

const defaultsSchema = z.object({
  max_results: z.number().int().min(1).max(20).default(8),
  timeout_ms: z.number().default(10000),
  total_budget_ms: z.number().default(30000),
  cooldown_default_s: z.number().default(60),
  cooldown_max_s: z.number().default(3600),
});

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  store_size: z.number().int().min(1).max(20).default(20),
  ttl_s: z.number().default(3600),
  ttl_fresh_s: z.number().default(900),
  max_entries: z.number().int().default(512),
});

export const configSchema = z.object({
  providers: z.array(providerSchema),
  defaults: defaultsSchema.default({}),
  cache: cacheSchema.default({}),
});

export type ProviderCfg = z.infer<typeof providerSchema>;
export type AppConfig = z.infer<typeof configSchema>;

export function defaultProviders(): ProviderCfg[] {
  return [
    { name: 'bocha', enabled: true, priority: 1, quota: { type: 'monthly', limit: 1000, reset_day: 1, quota_retry_s: 21600 } },
    { name: 'tavily', enabled: true, priority: 2, quota: { type: 'monthly', limit: 1000, reset_day: 2, quota_retry_s: 21600 } },
    { name: 'brave', enabled: true, priority: 3, quota: { type: 'monthly', limit: 2000, reset_day: 15, quota_retry_s: 21600 }, local_qps: 1 },
    { name: 'exa', enabled: true, priority: 4, quota: { type: 'one_time', limit: 800, quota_retry_s: 21600 } },
    { name: 'duckduckgo', enabled: true, priority: 5, quota: { type: 'unbounded', quota_retry_s: 21600 }, cooldown_max_s: 21600, min_interval_ms: 2000 },
  ];
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

  if (!raw['providers']) raw['providers'] = defaultProviders();

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    die(parsed.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
