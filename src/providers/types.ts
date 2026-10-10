import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult, type SearchRequest } from '../types.js';

export interface HttpResponseInfo {
  status: number;
  headers: Headers;
  bodyText: string;
}

/** 防御上限：异常大的响应体（如 challenge 页堆积 JS）不得无界读入内存 */
export const MAX_BODY_CHARS = 512 * 1024;

async function readTextCapped(res: Response, provider: string, limit = MAX_BODY_CHARS): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    out += done ? decoder.decode() : decoder.decode(value, { stream: true });
    if (out.length > limit) {
      // 个别流的 cancel 不会 resolve，不阻塞错误返回。
      void reader.cancel().catch(() => {});
      throw new ProviderError(provider, 'server_error', 'response_too_large');
    }
    if (done) return out;
  }
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
  try {
    const res = await fetch(url, { ...init, signal });
    return { status: res.status, headers: res.headers, bodyText: await readTextCapped(res, provider) };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    const name = e instanceof Error ? e.name : '';
    if (signal?.aborted || name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError(provider, 'timeout', 'aborted');
    }
    throw new ProviderError(provider, 'network', String(e instanceof Error ? e.message : e));
  }
}

/** 通用兜底：400/422 → request_error；5xx → server_error；其余 4xx 保留 soft 冷却 */
export function classifyDefault(res: HttpResponseInfo, provider: string): ProviderError {
  if (res.status === 400 || res.status === 422) {
    return new ProviderError(provider, 'request_error', `http_${res.status}`);
  }
  if (res.status >= 500) {
    return new ProviderError(provider, 'server_error', `http_${res.status}`);
  }
  return new ProviderError(provider, 'server_error', `http_${res.status}`, { soft: true });
}

/** Retry-After 头：秒数或 HTTP-date */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const v = headers.get('retry-after');
  if (!v?.trim()) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n)) return Number.isFinite(n * 1000) && n >= 0 ? n * 1000 : undefined;
  if (/^[+-]?\d/.test(v) && !/[A-Za-z]/.test(v)) return undefined;
  const date = Date.parse(v);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Brave X-RateLimit-Reset 头："1, 183945" → [秒级桶, 月配额桶] */
export function parseRateLimitResetBuckets(headers: Headers): { first?: number; second?: number } {
  const v = headers.get('x-ratelimit-reset');
  if (!v) return {};
  const parts = v.split(',').map(s => s.trim() ? Number(s.trim()) : NaN);
  return {
    first: Number.isFinite(parts[0]) && parts[0]! >= 0 ? parts[0] : undefined,
    second: Number.isFinite(parts[1]) && parts[1]! >= 0 ? parts[1] : undefined,
  };
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 成功响应严格验证实际消费的字段；错误体仍由 safeJson 尽力解析。 */
export function parseSuccess<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, provider: string): T {
  let json: unknown;
  try { json = JSON.parse(text); }
  catch { throw new ProviderError(provider, 'server_error', 'invalid_json'); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ProviderError(provider, 'server_error', 'invalid_response');
  return parsed.data;
}

export const CONTENT_MAX_CHARS = 2000;

/** 全空白视同没有正文，免得它挤掉来源自带的短摘要 */
export function truncateContent(s: string | undefined): string | undefined {
  return s?.trim() ? s.slice(0, CONTENT_MAX_CHARS) : undefined;
}

/** freshness → 各源枚举映射表（impl-spec §7；Exa/百度千帆在各自 adapter 里换算，不入此表） */
export const FRESHNESS: Record<string, Record<Freshness, string>> = {
  bocha: { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' },
  tavily: { day: 'day', week: 'week', month: 'month', year: 'year' },
  brave: { day: 'pd', week: 'pw', month: 'pm', year: 'py' },
  ddg: { day: 'd', week: 'w', month: 'm', year: 'y' },
  zhipu: { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' },
  serper: { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' },
};

export type { ProviderAdapter, RawResult, SearchRequest };
