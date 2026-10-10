import { z } from 'zod';
import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, FRESHNESS, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  content: z.string().nullish().transform(v => v ?? undefined),
  publish_date: z.string().nullish().transform(v => v ?? undefined),
});

const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const QUERY_MAX_CHARS = 70;

/**
 * 智谱 web_search。错误信号来自官方错误码文档（provider-expansion-spec §3.1，
 * 标注 [待 probe 证实] 的行为以契约测试 fixture 为准）：
 * 429+1113=欠费（quota）、429+1302=限流；body code 1703=引擎无数据 → 按 no_results 处理。
 */
export const zhipu: ProviderAdapter = {
  name: 'zhipu',
  maxCount: 50,
  note(req: SearchRequest): string | undefined {
    const notes: string[] = [];
    if (req.query.length > QUERY_MAX_CHARS) notes.push(`zhipu: query 超 ${QUERY_MAX_CHARS} 字符已截断`);
    if (req.includeDomains && req.includeDomains.length > 1) {
      notes.push('zhipu: 多域名过滤不支持（仅支持单域名），已忽略');
    }
    return notes.length ? notes.join('；') : undefined;
  },
  async search(req, fetchCount, signal) {
    const body: Record<string, unknown> = {
      search_query: req.query.slice(0, QUERY_MAX_CHARS),
      search_engine: process.env['ZHIPU_SEARCH_ENGINE'] || 'search_std',
      count: Math.min(fetchCount, 50),
      search_intent: false,
      content_size: 'medium',
    };
    if (req.freshness) body['search_recency_filter'] = FRESHNESS.zhipu[req.freshness];
    if (req.includeDomains?.length === 1) body['search_domain_filter'] = req.includeDomains[0];

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyFor('zhipu') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'zhipu', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ search_result: z.array(itemSchema) }), 'zhipu');
    const items = json.search_result;
    return items.map((it): RawResult => {
      const content = truncateContent(it.content);
      return {
        title: it.title,
        url: it.link,
        content,
        publishedDate: it.publish_date ?? undefined,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const body = safeJson(res.bodyText);
  const code = Number(body?.error?.code);

  if (res.status === 401 || [1000, 1001, 1003].includes(code)) {
    return new ProviderError('zhipu', 'auth_failure', `http_${res.status} ${code ?? ''}`.trim());
  }
  if (res.status === 429) {
    if (code === 1113) return new ProviderError('zhipu', 'quota_exhausted', 'http_429 1113_arrears');
    return new ProviderError('zhipu', 'rate_limited', `http_429 ${code ?? ''}`.trim()); // 1302 等
  }
  if (code === 1701) return new ProviderError('zhipu', 'rate_limited', 'code_1701_concurrency');
  if (code === 1703) return new ProviderError('zhipu', 'no_results', 'code_1703_no_data');
  if (code === 1210) return new ProviderError('zhipu', 'request_error', 'code_1210_bad_param');
  if (code === 1702) return new ProviderError('zhipu', 'server_error', 'code_1702_engine_unavailable', { soft: true });
  return classifyDefault(res, 'zhipu');
}
