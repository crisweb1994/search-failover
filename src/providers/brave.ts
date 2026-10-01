import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, parseRateLimitResetBuckets, rawRequest, safeJson,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/**
 * Brave。三个反直觉信号：auth 是 422+SUBSCRIPTION_TOKEN_INVALID（不是 401）；
 * 429 响应体 error.code 区分 RATE_LIMITED（秒级）与 QUOTA_LIMITED（月配额，重置点从
 * X-RateLimit-Reset 第二桶读，比日历推算准）。
 */
export const brave: ProviderAdapter = {
  name: 'brave',
  maxCount: 20,
  note(req: SearchRequest): string | undefined {
    if (!req.includeDomains?.length) return undefined;
    return req.includeDomains.length === 1
      ? undefined // 单域名用 site: 前缀实现
      : 'brave: 多域名过滤不支持（仅支持单域名 site:），已忽略';
  },
  async search(req, fetchCount, signal) {
    let q = req.query;
    if (req.includeDomains?.length === 1) q = `site:${req.includeDomains[0]} ${req.query}`;
    const params = new URLSearchParams({ q, count: String(fetchCount) });
    if (req.freshness) params.set('freshness', FRESHNESS.brave[req.freshness]);

    const res = await rawRequest(`${ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'X-Subscription-Token': apiKeyFor('brave') ?? '',
        Accept: 'application/json',
      },
    }, 'brave', signal);

    if (res.status !== 200) throw classify(res);
    const json = safeJson(res.bodyText);
    const items: any[] = json?.web?.results ?? [];
    return items
      .filter(it => it?.title && it?.url)
      .map((it): RawResult => ({
        title: String(it.title),
        url: String(it.url),
        snippet: it.description ? String(it.description) : undefined,
        publishedDate: it.page_age ?? parseAge(it.age),
      }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const body = safeJson(res.bodyText);
  const code = body?.error?.code;

  if (res.status === 422) {
    if (code === 'SUBSCRIPTION_TOKEN_INVALID') return new ProviderError('brave', 'auth_failure', 'http_422 SUBSCRIPTION_TOKEN_INVALID');
    return new ProviderError('brave', 'server_error', `http_422 ${code ?? ''}`, { soft: true });
  }
  if (res.status === 429) {
    const buckets = parseRateLimitResetBuckets(res.headers);
    if (code === 'QUOTA_LIMITED') {
      return new ProviderError('brave', 'quota_exhausted', 'http_429 QUOTA_LIMITED', {
        resetAtMs: buckets.second !== undefined ? Date.now() + buckets.second * 1000 : undefined,
      });
    }
    return new ProviderError('brave', 'rate_limited', `http_429 ${code ?? 'RATE_LIMITED'}`, {
      retryAfterMs: buckets.first !== undefined ? buckets.first * 1000 : undefined,
    });
  }
  if (res.status === 401) return new ProviderError('brave', 'auth_failure', 'http_401');
  return classifyDefault(res, 'brave');
}

/** "2 days ago" 类相对时间尽力解析为 YYYY-MM-DD，失败返回 undefined */
export function parseAge(age: string | undefined): string | undefined {
  if (!age) return undefined;
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?/i.exec(String(age));
  if (!m) return undefined;
  const units: Record<string, number> = {
    second: 1_000, minute: 60_000, hour: 3_600_000,
    day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000,
  };
  const ms = Number(m[1]) * (units[m[2]!.toLowerCase()] ?? 0);
  return new Date(Date.now() - ms).toISOString().slice(0, 10);
}
