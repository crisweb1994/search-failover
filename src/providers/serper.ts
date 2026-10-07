import { z } from 'zod';
import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, rawRequest, parseSuccess,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  snippet: z.string().nullish().transform(v => v ?? undefined),
  date: z.string().nullish().transform(v => v ?? undefined),
});

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
      num: Math.min(fetchCount, 100), // 计费分档待实际核实；本地按请求尝试计数，不等同 credits
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
    const json = parseSuccess(res.bodyText, z.object({ organic: z.array(itemSchema) }), 'serper');
    const items = json.organic;
    return items.map((it): RawResult => ({
      title: it.title,
      url: it.link,
      snippet: it.snippet || undefined,
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
