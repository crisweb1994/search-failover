import { z } from 'zod';
import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, rawRequest, safeJson, parseSuccess, snippetFrom, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const itemSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  summary: z.string().nullish().transform(v => v ?? undefined),
  snippet: z.string().nullish().transform(v => v ?? undefined),
  datePublished: z.string().nullish().transform(v => v ?? undefined),
  dateLastCrawled: z.string().nullish().transform(v => v ?? undefined),
});

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
    const json = parseSuccess(res.bodyText, z.union([z.object({ data: z.object({ webPages: z.object({ value: z.array(itemSchema) }) }) }), z.object({ webPages: z.object({ value: z.array(itemSchema) }) })]), 'bocha');
    const items = 'data' in json ? json.data.webPages.value : json.webPages.value;
    return items.map((it): RawResult => ({
      title: it.name,
      url: it.url,
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
  const body = safeJson(res.bodyText);
  const msg = body?.msg ?? body?.message;
  return msg ? String(msg).slice(0, 120) : '';
}
