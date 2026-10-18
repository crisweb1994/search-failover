import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cleanValue, readEnv, type Env } from './env.js';
import { CREDENTIAL_ENVS, PROVIDERS, PROVIDER_NAMES, REGISTRY } from './providers/registry.js';
import type { ProviderDefinition } from './providers/types.js';

const quotaSchema = z.object({
  type: z.enum(['monthly', 'one_time', 'unbounded']),
  limit: z.number().int().nonnegative().optional(),
  reset_day: z.number().int().min(1).max(31).optional(),
}).strict();

export type QuotaCfg = z.infer<typeof quotaSchema>;

/** 配置文件里的来源条目：省略的字段继承该源默认值 */
const providerEntrySchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  quota: quotaSchema.partial().optional(),
  /** 上游配额错误缺少恢复时间时的等待间隔，与本地计数窗口无关 */
  quota_retry_s: z.number().finite().nonnegative().optional(),
  /** 本地 QPS 限制，请求间隔不足时本地补齐等待 */
  local_qps: z.number().finite().positive().optional(),
  /** 请求最小间隔毫秒（DDG 礼貌间隔） */
  min_interval_ms: z.number().int().nonnegative().optional(),
  /** 该源冷却时长上限覆盖（秒） */
  cooldown_max_s: z.number().finite().nonnegative().optional(),
}).strict();

type ProviderEntry = z.infer<typeof providerEntrySchema>;

const defaultsSchema = z.object({
  timeout_ms: z.number().int().positive().default(10000),
  total_budget_ms: z.number().int().positive().default(30000),
  cooldown_default_s: z.number().finite().nonnegative().default(60),
  cooldown_max_s: z.number().finite().nonnegative().default(3600),
  /** 单次返回里 content/snippet 的总字符预算，超出时按比例缩短每条正文 */
  max_output_chars: z.number().int().positive().default(12000),
}).strict();

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  ttl_s: z.number().finite().nonnegative().default(3600),
  ttl_fresh_s: z.number().finite().nonnegative().default(900),
  max_entries: z.number().int().nonnegative().default(512),
}).strict();

const fileSchema = z.object({
  /** 运行链：数组顺序就是优先级；列出即启用（`enabled: false` 可暂时停用） */
  providers: z.array(providerEntrySchema).optional(),
  /** 以环境变量名为键的凭据，环境变量优先；所有宿主共用一份 */
  credentials: z.record(z.string()).optional(),
  defaults: defaultsSchema.default({}),
  cache: cacheSchema.default({}),
}).strict();

/** 运行时的单个来源配置（已合并默认值） */
export interface ProviderCfg {
  name: string;
  quota: QuotaCfg;
  quota_retry_s: number;
  local_qps?: number;
  min_interval_ms?: number;
  cooldown_max_s?: number;
}

export interface AppConfig {
  /** 运行链，已按优先级排列；是否有凭据由 runtime 另行判断 */
  providers: ProviderCfg[];
  /** 配置文件提供的凭据（键为环境变量名） */
  credentials: Record<string, string>;
  defaults: z.infer<typeof defaultsSchema>;
  cache: z.infer<typeof cacheSchema>;
}

export interface LoadedConfig {
  config: AppConfig;
  /** 实际读取的配置文件路径；没有配置文件时为 undefined */
  source?: string;
  /** 配置错误：网关照常启动，但不运行任何来源，每次搜索都返回这条错误 */
  error?: string;
}

export class ConfigError extends Error {
  constructor(message: string, readonly fromEnv = false) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULT_QUOTA_RETRY_S = 21600;

export function defaultProviderCfg(def: ProviderDefinition): ProviderCfg {
  return { name: def.adapter.name, quota: { ...def.quota }, quota_retry_s: DEFAULT_QUOTA_RETRY_S, ...def.extraDefaults };
}

export function emptyConfig(): AppConfig {
  return { providers: [], credentials: {}, defaults: defaultsSchema.parse({}), cache: cacheSchema.parse({}) };
}

/** 条目覆盖默认值；quota 类型不变时按字段合并，切换类型则整体替换 */
function mergeEntry(base: ProviderCfg, entry: ProviderEntry | undefined): ProviderCfg {
  if (!entry) return base;
  const { name: _name, enabled: _enabled, quota, ...overrides } = entry;
  const merged: ProviderCfg = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  if (quota) {
    merged.quota = quota.type && quota.type !== base.quota.type ? quotaSchema.parse(quota) : { ...base.quota, ...quota };
  }
  return merged;
}

/** 运行链的名单与顺序：SEARCH_FAILOVER_PROVIDERS > 配置文件 providers > 注册表默认链 */
function chainNames(file: z.infer<typeof fileSchema>, env: Env): string[] {
  const fromEnv = readEnv('SEARCH_FAILOVER_PROVIDERS', env);
  if (fromEnv !== undefined) {
    const names = fromEnv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const seen = new Set<string>();
    for (const name of names) {
      if (!REGISTRY[name]) {
        throw new ConfigError(`SEARCH_FAILOVER_PROVIDERS: unknown provider "${name}" (expected: ${PROVIDER_NAMES.join(', ')})`, true);
      }
      if (seen.has(name)) throw new ConfigError(`SEARCH_FAILOVER_PROVIDERS: duplicate provider "${name}"`, true);
      seen.add(name);
    }
    return names;
  }
  if (file.providers) return file.providers.filter(entry => entry.enabled !== false).map(entry => entry.name);
  return PROVIDERS.filter(def => def.defaultEnabled).map(def => def.adapter.name);
}

/** 纯解析：不读文件，不碰全局状态；出错抛 ZodError / ConfigError */
export function parseConfig(input: unknown, env: Env = process.env): AppConfig {
  const file = fileSchema.parse(input);
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(file.credentials ?? {})) {
    if (!CREDENTIAL_ENVS.includes(key)) {
      throw new ConfigError(`credentials.${key}: unknown key (expected: ${CREDENTIAL_ENVS.join(', ')})`);
    }
    const clean = cleanValue(value);
    if (clean) credentials[key] = clean;
  }
  const entries = new Map<string, ProviderEntry>();
  (file.providers ?? []).forEach((entry, i) => {
    if (!REGISTRY[entry.name]) {
      throw new ConfigError(`providers.${i}.name: unknown provider "${entry.name}" (expected: ${PROVIDER_NAMES.join(', ')})`);
    }
    if (entries.has(entry.name)) throw new ConfigError(`providers.${i}.name: duplicate provider "${entry.name}"`);
    entries.set(entry.name, entry);
  });
  return {
    providers: chainNames(file, env).map(name => mergeEntry(defaultProviderCfg(REGISTRY[name]!), entries.get(name))),
    credentials,
    defaults: file.defaults,
    cache: file.cache,
  };
}

/** 把报错整理成"位置: 问题"，拼错的字段名一眼可见 */
export function describeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map(issue => {
      const where = issue.path.join('.') || '(root)';
      const what = issue.code === 'unrecognized_keys' ? `unknown field ${issue.keys.map(k => `"${k}"`).join(', ')}` : issue.message;
      return `${where}: ${what}`;
    }).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

/** 用户级配置文件：所有宿主共用；$XDG_CONFIG_HOME 优先，Windows 用 %APPDATA% */
export function userConfigPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const xdg = readEnv('XDG_CONFIG_HOME', env);
  if (xdg) return join(xdg, 'search-failover', 'config.json');
  const appData = platform === 'win32' ? readEnv('APPDATA', env) : undefined;
  if (appData) return join(appData, 'search-failover', 'config.json');
  return join(readEnv('HOME', env) ?? homedir(), '.config', 'search-failover', 'config.json');
}

/**
 * 加载顺序：$SEARCH_FAILOVER_CONFIG（必须存在且合法）→ 用户级配置文件（不存在则全默认）。
 * 不读当前目录：宿主的 cwd 各不相同，而且仓库里的配置文件不应替用户打开付费源。
 * 出错时不退出进程，返回 error，由工具把错误带进每个宿主的对话里。
 */
export function loadConfig(env: Env = process.env): LoadedConfig {
  const explicit = readEnv('SEARCH_FAILOVER_CONFIG', env);
  const path = explicit ?? userConfigPath(env);
  let raw: unknown = {};
  let source: string | undefined;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
    source = path;
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (explicit || !missing) {
      return { config: emptyConfig(), source: path, error: `cannot read ${path}: ${(err as Error).message}` };
    }
  }
  try {
    return { config: parseConfig(raw, env), source };
  } catch (err) {
    const fromEnv = err instanceof ConfigError && err.fromEnv;
    const message = describeConfigError(err);
    return { config: emptyConfig(), source, error: source && !fromEnv ? `${source}: ${message}` : message };
  }
}
