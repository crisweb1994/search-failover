export type Freshness = 'day' | 'week' | 'month' | 'year';

/** search 工具归一化入参（v1.2.1：6 参数） */
export interface SearchRequest {
  query: string;
  maxResults: number;
  freshness?: Freshness;
  includeDomains?: string[];
  provider?: string;
  useCache: boolean;
}

/** 六类标准错误（timeout/network 动作相同，保留两个标签只为链上信息更准） */
export type ErrorType =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'auth_failure'
  | 'timeout'
  | 'network'
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

/** adapter 返回的原始结果（统一字段，来源字段映射见 impl-spec §7） */
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

/** adapter 无状态纯函数；状态全在 state.ts */
export interface ProviderAdapter {
  readonly name: string;
  readonly maxCount: number;
  search(req: SearchRequest, fetchCount: number, signal: AbortSignal): Promise<RawResult[]>;
  /** 该源不支持请求中的某些参数时返回降级说明（写入 meta.note） */
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
