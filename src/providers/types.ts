import { ProviderError, type Freshness, type ProviderAdapter, type RawResult, type SearchRequest } from '../types.js';

export interface HttpResponseInfo {
  status: number;
  headers: Headers;
  bodyText: string;
}

/**
 * fetch 包装：网络异常/超时统一映射为 ProviderError（timeout/network），
 * HTTP 状态码原样返回，由各家 adapter 的 classify 决定分类。
 */
export async function rawRequest(
  url: string,
  init: RequestInit,
  provider: string,
  signal?: AbortSignal,
): Promise<HttpResponseInfo> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError(provider, 'timeout', 'aborted');
    }
    throw new ProviderError(provider, 'network', String(e instanceof Error ? e.message : e));
  }
  return { status: res.status, headers: res.headers, bodyText: await res.text() };
}

/** 通用兜底：5xx → server_error；未识别 4xx → server_error 但 soft（不计入失败阶梯） */
export function classifyDefault(res: HttpResponseInfo, provider: string): ProviderError {
  if (res.status >= 500) {
    return new ProviderError(provider, 'server_error', `http_${res.status}`);
  }
  return new ProviderError(provider, 'server_error', `http_${res.status}`, { soft: true });
}

/** Retry-After 头：秒数或 HTTP-date */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return n * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : date - Date.now();
}

/** Brave X-RateLimit-Reset 头："1, 183945" → [秒级桶, 月配额桶] */
export function parseRateLimitResetBuckets(headers: Headers): { first?: number; second?: number } {
  const v = headers.get('x-ratelimit-reset');
  if (!v) return {};
  const parts = v.split(',').map(s => Number(s.trim()));
  return {
    first: Number.isFinite(parts[0]) ? parts[0] : undefined,
    second: Number.isFinite(parts[1]) ? parts[1] : undefined,
  };
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const CONTENT_MAX_CHARS = 2000;
export const SNIPPET_MAX_CHARS = 300;

export function truncateContent(s: string | undefined): string | undefined {
  return s ? s.slice(0, CONTENT_MAX_CHARS) : undefined;
}

export function snippetFrom(content: string | undefined, fallback?: string): string | undefined {
  const c = content?.trim();
  if (c) return c.slice(0, SNIPPET_MAX_CHARS);
  return fallback || undefined;
}

/** freshness → 各源枚举映射表（impl-spec §7；Exa 在自己的 adapter 里换算天数） */
export const FRESHNESS: Record<string, Record<Freshness, string>> = {
  bocha: { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' },
  tavily: { day: 'day', week: 'week', month: 'month', year: 'year' },
  brave: { day: 'pd', week: 'pw', month: 'pm', year: 'py' },
  ddg: { day: 'd', week: 'w', month: 'm', year: 'y' },
};

export type { ProviderAdapter, RawResult, SearchRequest };
