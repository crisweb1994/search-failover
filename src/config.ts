import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { log } from './logger.js';
import { defaultProviderConfigs } from './providers/registry.js';

const quotaRetrySchema = z.number().finite().nonnegative();

const quotaSchema = z.object({
  type: z.enum(['monthly', 'one_time', 'unbounded']).default('unbounded'),
  limit: z.number().int().nonnegative().optional(),
  reset_day: z.number().int().min(1).max(31).optional(),
}).strict();

export const providerSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  quota: quotaSchema.default({}),
  /** 上游配额错误缺少恢复时间时的等待间隔，与本地计数窗口无关。 */
  quota_retry_s: quotaRetrySchema.default(21600),
  /** 本地 QPS 限制（Brave 默认保守设为 1 QPS），请求间隔不足时本地补齐等待 */
  local_qps: z.number().finite().positive().optional(),
  /** 请求最小间隔毫秒（DDG 礼貌间隔） */
  min_interval_ms: z.number().int().nonnegative().optional(),
  /** 该源冷却时长上限覆盖（秒）；DDG 被封需要 6h */
  cooldown_max_s: z.number().finite().nonnegative().optional(),
}).strict();

const defaultsSchema = z.object({
  timeout_ms: z.number().int().positive().default(10000),
  total_budget_ms: z.number().int().positive().default(30000),
  cooldown_default_s: z.number().finite().nonnegative().default(60),
  cooldown_max_s: z.number().finite().nonnegative().default(3600),
}).strict();

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  ttl_s: z.number().finite().nonnegative().default(3600),
  ttl_fresh_s: z.number().finite().nonnegative().default(900),
  max_entries: z.number().int().nonnegative().default(512),
}).strict();

export const configSchema = z.object({
  providers: z.array(providerSchema),
  defaults: defaultsSchema.default({}),
  cache: cacheSchema.default({}),
}).strict();

export type ProviderCfg = z.infer<typeof providerSchema>;
export type AppConfig = z.infer<typeof configSchema>;

/** 默认配置由注册表生成（D15：名单单一事实来源；opt-in 源 enabled=false） */
export function defaultProviders(): ProviderCfg[] {
  return defaultProviderConfigs().map(p => providerSchema.parse(p));
}

/**
 * 名单由用户决定；仅继承所列来源的默认字段，不做递归合并。
 * 旧字段（fetch_policy / cache.store_size / quota.quota_retry_s）仍按原范围校验，但在进入严格校验前剥离；
 * 其余未知字段（多半是拼错的字段名）一律报错，避免 `limt` 这类拼写让付费来源的本地上限悄悄失效。
 */
export function parseConfig(input: unknown): AppConfig {
  const raw = z.object({
    providers: z.array(z.object({
      name: z.string(),
      quota_retry_s: quotaRetrySchema.optional(),
      quota: quotaSchema.partial().extend({ quota_retry_s: quotaRetrySchema.optional() }).optional(),
      fetch_policy: z.enum(['cache_fill', 'as_requested']).optional(),
    }).passthrough()).optional(),
    cache: z.object({ store_size: z.number().int().min(1).max(20).optional() }).passthrough().optional(),
  }).passthrough().parse(input);
  const defaults = defaultProviders();
  const seen = new Set<string>();
  const providers = raw.providers?.map(({ fetch_policy: _fetchPolicy, quota: given, quota_retry_s, ...p }) => {
    const base = defaults.find(d => d.name === p.name);
    if (!base) throw new Error(`未知来源: ${p.name}`);
    if (seen.has(p.name)) throw new Error(`重复来源: ${p.name}`);
    seen.add(p.name);
    const { quota_retry_s: legacyRetryS, ...override } = given ?? {};
    const quota = override.type && override.type !== base.quota.type
      ? override : { ...base.quota, ...override };
    return { ...base, ...p, quota, quota_retry_s: quota_retry_s ?? legacyRetryS ?? base.quota_retry_s };
  }) ?? defaults;
  const { store_size: _storeSize, ...cache } = raw.cache ?? {};
  return configSchema.parse({ ...raw, providers, ...(raw.cache && { cache }) });
}

/** 把 zod 报错整理成"位置: 问题"，拼错的字段名一眼可见（原始 JSON 在宿主日志里很难读） */
export function describeConfigError(err: unknown): string {
  if (!(err instanceof z.ZodError)) return String(err instanceof Error ? err.message : err);
  return err.issues.map(issue => {
    const where = issue.path.join('.') || '(顶层)';
    return `${where}: ${issue.code === 'unrecognized_keys' ? `未知字段 ${issue.keys.join(', ')}` : issue.message}`;
  }).join('；');
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
    die(describeConfigError(err));
  }
}
