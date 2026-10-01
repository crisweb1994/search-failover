import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, rawRequest, safeJson, snippetFrom, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const ENDPOINT = 'https://api.bochaai.com/v1/web-search';

/**
 * 博查（Bing 兼容响应）。错误分类注意：403 是余额不足（quota），401 才是 key 无效。
 */
export const bocha: ProviderAdapter = {
  name: 'bocha',
  maxCount: 50,
  note(req: SearchRequest): string | undefined {
    return req.includeDomains?.length ? 'bocha: include_domains 不支持，已忽略' : undefined;
  },
  async search(req, fetchCount, signal) {
    const body: Record<string, unknown> = { query: req.query, count: fetchCount, summary: true };
    if (req.freshness) body['freshness'] = FRESHNESS.bocha[req.freshness];
    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyFor('bocha') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'bocha', signal);

    if (res.status !== 200) throw classify(res);
    const json = safeJson(res.bodyText);
    const items: any[] = json?.data?.webPages?.value ?? json?.webPages?.value ?? [];
    return items
      .filter(it => it?.name && it?.url)
      .map((it): RawResult => ({
        title: String(it.name),
        url: String(it.url),
        snippet: snippetFrom(truncateContent(it.summary), it.snippet),
        content: truncateContent(it.summary),
        publishedDate: it.datePublished ?? it.dateLastCrawled ?? undefined,
      }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('bocha', 'auth_failure', `http_401 ${bodyMsg(res)}`);
  if (res.status === 403) return new ProviderError('bocha', 'quota_exhausted', `http_403 ${bodyMsg(res)}`);
  if (res.status === 429) return new ProviderError('bocha', 'rate_limited', `http_429 ${bodyMsg(res)}`);
  return classifyDefault(res, 'bocha');
}

function bodyMsg(res: HttpResponseInfo): string {
  const msg = safeJson(res.bodyText)?.msg ?? safeJson(res.bodyText)?.message;
  return msg ? String(msg).slice(0, 120) : '';
}
