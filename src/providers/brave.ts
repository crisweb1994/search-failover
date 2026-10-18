import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult } from '../types.js';
import {
  classifyDefault, optionalString, parseRateLimitResetBuckets, rawRequest, safeJson, parseSuccess,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  description: optionalString,
  page_age: optionalString,
  age: optionalString,
});

/**
 * Brave 的响应模型里 `web` 是可选字段，唯一必有的是 `type: "search"`：
 * 有 `type` 而没有 `web` 就是没有网页结果；两者都没有才算异常响应。
 */
const responseSchema = z.object({
  type: z.string().optional(),
  web: z.object({ results: z.array(itemSchema) }).optional(),
}).refine(v => v.web !== undefined || v.type === 'search');

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const FRESHNESS: Record<Freshness, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

/**
 * Brave。三个反直觉信号：auth 是 422+SUBSCRIPTION_TOKEN_INVALID（不是 401）；
 * 429 响应体 error.code 区分 RATE_LIMITED（秒级）与 QUOTA_LIMITED（月配额，重置点从
 * X-RateLimit-Reset 第二桶读，比日历推算准）。
 */
export const brave: ProviderAdapter = {
  name: 'brave',
  maxCount: 20,
  includeDomains: 'single',
  async search(req, fetchCount, signal, credential) {
    const q = req.includeDomains?.length === 1 ? `site:${req.includeDomains[0]} ${req.query}` : req.query;
    const params = new URLSearchParams({ q, count: String(fetchCount) });
    if (req.freshness) params.set('freshness', FRESHNESS[req.freshness]);

    const res = await rawRequest(`${ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: { 'X-Subscription-Token': credential ?? '', Accept: 'application/json' },
    }, 'brave', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, responseSchema, 'brave');
    return (json.web?.results ?? []).map((it): RawResult => ({
      title: it.title,
      url: it.url,
      snippet: it.description || undefined,
      publishedDate: it.page_age ?? parseAge(it.age),
    }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const body = safeJson(res.bodyText);
  const code = body?.error?.code;

  if (res.status === 422) {
    if (code === 'SUBSCRIPTION_TOKEN_INVALID') return new ProviderError('brave', 'auth_failure', 'http_422 SUBSCRIPTION_TOKEN_INVALID');
    return new ProviderError('brave', 'request_error', `http_422 ${code ?? ''}`.trim());
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

export const definition: ProviderDefinition = {
  adapter: brave,
  label: 'Brave Search',
  credentialEnv: 'BRAVE_API_KEY',
  defaultEnabled: true,
  // 2026-10-04 api-dashboard.search.brave.com/documentation/pricing：月度 credits 折算参考，非余额。
  quota: { type: 'monthly', limit: 1000, reset_day: 15 },
  extraDefaults: { local_qps: 1 },
};
