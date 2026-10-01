import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { log } from './logger.js';
import { defaultProviderConfigs } from './providers/registry.js';

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
  /**
   * 取数策略（D12）：cache_fill=一次取足 min(store_size, maxCount) 喂缓存（按请求计费源）；
   * as_requested=只取 maxResults（按结果数计费源，如 Firecrawl，Phase 2 起用）。
   */
  fetch_policy: z.enum(['cache_fill', 'as_requested']).default('cache_fill'),
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

/** 默认配置由注册表生成（D15：名单单一事实来源；opt-in 源 enabled=false） */
export function defaultProviders(): ProviderCfg[] {
  return defaultProviderConfigs();
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
