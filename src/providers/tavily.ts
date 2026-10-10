import { z } from 'zod';
import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult } from '../types.js';
import {
  classifyDefault, FRESHNESS, parseRetryAfterMs, rawRequest, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  content: z.string().nullish().transform(v => v ?? undefined),
  published_date: z.string().nullish().transform(v => v ?? undefined),
  score: z.number().nullish().transform(v => v ?? undefined),
});

const ENDPOINT = 'https://api.tavily.com/search';

/** Tavily：429+Retry-After=限速；432/433=套餐配额耗尽 */
export const tavily: ProviderAdapter = {
  name: 'tavily',
  maxCount: 20,
  async search(req, fetchCount, signal) {
    const body: Record<string, unknown> = {
      query: req.query,
      max_results: fetchCount,
      search_depth: 'basic',
      include_published_date: true,
    };
    if (req.freshness) body['time_range'] = FRESHNESS.tavily[req.freshness];
    if (req.includeDomains?.length) body['include_domains'] = req.includeDomains;

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyFor('tavily') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'tavily', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ results: z.array(itemSchema) }), 'tavily');
    const items = json.results;
    return items.map((it): RawResult => {
      const content = truncateContent(it.content);
      return {
        title: it.title,
        url: it.url,
        content,
        score: typeof it.score === 'number' ? it.score : undefined,
        publishedDate: it.published_date ?? undefined,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('tavily', 'auth_failure', 'http_401');
  if (res.status === 429) {
    return new ProviderError('tavily', 'rate_limited', 'http_429', { retryAfterMs: parseRetryAfterMs(res.headers) });
  }
  if (res.status === 432 || res.status === 433) {
    // 上游没给恢复时间：由 state 按 quota_retry_s 等待，与本地 reset_day 无关
    return new ProviderError('tavily', 'quota_exhausted', `http_${res.status}`);
  }
  return classifyDefault(res, 'tavily');
}
