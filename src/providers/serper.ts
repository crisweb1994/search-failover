import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, rawRequest, safeJson,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const ENDPOINT = 'https://google.serper.dev/search';

/**
 * Serper.dev（Google SERP）。官方无独立文档页，字段与错误码来自
 * playground/第三方实测口径（provider-expansion-spec §3.3）：
 * 402=credit 耗尽（一次性，无重置点）、401=key 无效、429=QPS 限制。
 */
export const serper: ProviderAdapter = {
  name: 'serper',
  maxCount: 100,
  note(req: SearchRequest): string | undefined {
    if (!req.includeDomains?.length) return undefined;
    return req.includeDomains.length === 1
      ? undefined // 单域名用 site: 前缀实现（Brave 同款）
      : 'serper: 多域名过滤不支持（仅支持单域名 site:），已忽略';
  },
  async search(req, fetchCount, signal) {
    let q = req.query;
    if (req.includeDomains?.length === 1) q = `site:${req.includeDomains[0]} ${req.query}`;
    const body: Record<string, unknown> = {
      q,
      num: Math.min(fetchCount, 100), // num=100 才计 2 credits；本网关封顶 20 恒为 1 credit
    };
    if (req.freshness) body['tbs'] = FRESHNESS.serper[req.freshness];

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKeyFor('serper') ?? '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'serper', signal);

    if (res.status !== 200) throw classify(res);
    const json = safeJson(res.bodyText);
    const items: any[] = json?.organic ?? [];
    return items
      .filter(it => it?.title && it?.link)
      .map((it): RawResult => ({
        title: String(it.title),
        url: String(it.link),
        snippet: it.snippet ? String(it.snippet) : undefined,
        publishedDate: it.date ?? undefined,
      }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('serper', 'auth_failure', 'http_401');
  if (res.status === 402) return new ProviderError('serper', 'quota_exhausted', 'http_402_credits_exhausted');
  if (res.status === 429) return new ProviderError('serper', 'rate_limited', 'http_429');
  return classifyDefault(res, 'serper');
}
