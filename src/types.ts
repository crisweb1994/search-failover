export type Freshness = 'day' | 'week' | 'month' | 'year';

/** web_search 归一化入参 */
export interface SearchRequest {
  query: string;
  maxResults: number;
  freshness?: Freshness;
  includeDomains?: string[];
  /** 仅调试模式可用：强制单一来源 */
  provider?: string;
  useCache: boolean;
}

/** 标准错误分类（timeout/network 动作相同，保留两个标签只为链上信息更准） */
export type ErrorType =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failure'
  | 'timeout'
  | 'network'
  | 'request_error'
  | 'server_error'
  | 'no_results';

export interface ProviderErrorOptions {
  /** rate_limited：上游建议的冷却时长 */
  retryAfterMs?: number;
  /** quota_exhausted：精确恢复时间点（Brave X-RateLimit-Reset 第二桶） */
  resetAtMs?: number;
  /** 未识别 4xx：走 server_error 的冷却路径但不计入失败阶梯 */
  soft?: boolean;
}

/** adapter 抛出的唯一异常类型；分类逻辑在每个 adapter 内部 */
export class ProviderError extends Error {
  readonly retryAfterMs?: number;
  readonly resetAtMs?: number;
  readonly soft: boolean;

  constructor(
    readonly provider: string,
    readonly type: ErrorType,
    readonly detail: string,
    options: ProviderErrorOptions = {},
  ) {
    super(`${provider}:${type}(${detail})`);
    this.name = 'ProviderError';
    this.retryAfterMs = options.retryAfterMs;
    this.resetAtMs = options.resetAtMs;
    this.soft = options.soft ?? false;
  }
}

/** adapter 返回的原始结果（统一字段） */
export interface RawResult {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  score?: number;
  publishedDate?: string;
}

export interface SearchResult extends RawResult {
  provider: string;
}

/** include_domains 支持级别：native=多域名原生 / single=单域名（site: 或单值参数）/ none=不支持 */
export type DomainFilterCap = 'native' | 'single' | 'none';

/** adapter 无状态：凭据由调用方传入，健康与计数全在 state.ts */
export interface ProviderAdapter {
  readonly name: string;
  readonly maxCount: number;
  readonly includeDomains: DomainFilterCap;
  /** credential：该源的 key 或实例地址（免凭据的源为 undefined） */
  search(req: SearchRequest, fetchCount: number, signal: AbortSignal, credential?: string): Promise<RawResult[]>;
  /** include_domains 以外的降级说明（截断、忽略某个参数）；只在该源给出结果时写入 meta.note */
  note?(req: SearchRequest): string | undefined;
}

export interface FallbackStep {
  provider: string;
  outcome: string;
  detail?: string;
  elapsedMs: number;
}

export interface SearchMeta {
  provider_used: string | null;
  fallback_chain: FallbackStep[];
  cache_hit: boolean;
  elapsed_ms: number;
  note?: string;
}
