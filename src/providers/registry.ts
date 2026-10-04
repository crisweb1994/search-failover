import { CREDENTIALS } from '../credentials.js';
import type { ProviderCfg } from '../config.js';
import type { ProviderAdapter } from '../types.js';
import { bocha } from './bocha.js';
import { zhipu } from './zhipu.js';
import { tavily } from './tavily.js';
import { qianfan } from './qianfan.js';
import { brave } from './brave.js';
import { serper } from './serper.js';
import { exa } from './exa.js';
import { duckduckgo } from './ddg.js';

/** include_domains 支持级别：native=多域名原生 / single=单域名（site: 或单值参数）/ none=忽略 */
export type DomainFilterCap = 'native' | 'single' | 'none';

/**
 * Provider 注册表（D15）：名单的单一事实来源。
 * defaultProviders() / MCP describe 文本 / 测试一致性断言全部从这里派生。
 * 依赖方向（无环）：registry → adapter → credentials；config → registry（type-only 反向）。
 */
export interface ProviderRegistration {
  readonly adapter: ProviderAdapter;
  /** 取自 CREDENTIALS（凭据事实放在叶子模块，避免环） */
  readonly credential: (typeof CREDENTIALS)[string];
  /** 进默认配置的 enabled 初值；false = opt-in 源（D14：付费/一次性 credit 源默认不进链） */
  readonly defaultEnabled: boolean;
  /** 进默认配置的 priority（§2：存量五家相对顺序不变，新源穿插） */
  readonly priority: number;
  readonly quotaDefault: ProviderCfg['quota'];
  /** 透传到 ProviderCfg 的额外默认值 */
  readonly extraDefaults?: Partial<Pick<ProviderCfg, 'local_qps' | 'min_interval_ms' | 'cooldown_max_s' | 'fetch_policy'>>;
  /** 能力矩阵：生成 MCP describe 文本（D15）；adapter 的 note() 行为须与之保持一致 */
  readonly capabilities: {
    freshness: boolean;
    includeDomains: DomainFilterCap;
  };
}

export const REGISTRY: Record<string, ProviderRegistration> = {
  bocha: {
    adapter: bocha, credential: CREDENTIALS['bocha']!, defaultEnabled: true, priority: 1,
    quotaDefault: { type: 'monthly', limit: 1000, reset_day: 1, quota_retry_s: 21600 },
    capabilities: { freshness: true, includeDomains: 'none' },
  },
  zhipu: {
    adapter: zhipu, credential: CREDENTIALS['zhipu']!, defaultEnabled: false, priority: 2,
    // 纯按量计费无免费额度：不设 limit（软闸门只对设了 limit 的生效），停发依赖 429+1113 欠费错误
    quotaDefault: { type: 'one_time', quota_retry_s: 21600 },
    capabilities: { freshness: true, includeDomains: 'single' },
  },
  tavily: {
    adapter: tavily, credential: CREDENTIALS['tavily']!, defaultEnabled: true, priority: 3,
    quotaDefault: { type: 'monthly', limit: 1000, reset_day: 2, quota_retry_s: 21600 },
    capabilities: { freshness: true, includeDomains: 'native' },
  },
  qianfan: {
    adapter: qianfan, credential: CREDENTIALS['qianfan']!, defaultEnabled: false, priority: 4,
    quotaDefault: { type: 'monthly', limit: 1500, reset_day: 1, quota_retry_s: 21600 },
    extraDefaults: { local_qps: 1 }, // 官方默认 1 QPS
    capabilities: { freshness: true, includeDomains: 'native' },
  },
  brave: {
    adapter: brave, credential: CREDENTIALS['brave']!, defaultEnabled: true, priority: 5,
    // 2026-10-04 api-dashboard.search.brave.com/documentation/pricing：月度 credits 折算参考，非余额。
    quotaDefault: { type: 'monthly', limit: 1000, reset_day: 15, quota_retry_s: 21600 },
    extraDefaults: { local_qps: 1 },
    capabilities: { freshness: true, includeDomains: 'single' },
  },
  serper: {
    adapter: serper, credential: CREDENTIALS['serper']!, defaultEnabled: false, priority: 6,
    quotaDefault: { type: 'one_time', limit: 2500, quota_retry_s: 21600 },
    extraDefaults: { local_qps: 1 }, // 免费档 1 QPS 为第三方口径，保守起步
    capabilities: { freshness: true, includeDomains: 'single' },
  },
  exa: {
    adapter: exa, credential: CREDENTIALS['exa']!, defaultEnabled: true, priority: 7,
    // 2026-10-04 exa.ai/pricing：月度 credits；800 仅为兼容的本地请求预算。
    quotaDefault: { type: 'monthly', limit: 800, reset_day: 1, quota_retry_s: 21600 },
    extraDefaults: { fetch_policy: 'as_requested' },
    capabilities: { freshness: true, includeDomains: 'native' },
  },
  duckduckgo: {
    adapter: duckduckgo, credential: CREDENTIALS['duckduckgo']!, defaultEnabled: true, priority: 8,
    quotaDefault: { type: 'unbounded', quota_retry_s: 21600 },
    extraDefaults: { cooldown_max_s: 21600, min_interval_ms: 2000 },
    capabilities: { freshness: true, includeDomains: 'none' },
  },
};

/** 默认 provider 配置：由注册表按 priority 排序生成（config.defaultProviders 的数据源） */
export function defaultProviderConfigs(): ProviderCfg[] {
  return Object.values(REGISTRY)
    .sort((a, b) => a.priority - b.priority)
    .map(r => ({
      name: r.adapter.name,
      enabled: r.defaultEnabled,
      priority: r.priority,
      quota: r.quotaDefault,
      fetch_policy: r.extraDefaults?.fetch_policy ?? 'cache_fill',
      local_qps: r.extraDefaults?.local_qps,
      min_interval_ms: r.extraDefaults?.min_interval_ms,
      cooldown_max_s: r.extraDefaults?.cooldown_max_s,
    }));
}
