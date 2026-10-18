import { z } from 'zod';
import { readEnv } from '../env.js';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, optionalString, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  content: optionalString,
  publish_date: optionalString,
});

const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const QUERY_MAX_CHARS = 70;
const FRESHNESS: Record<Freshness, string> = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };

/**
 * 智谱 web_search。错误信号来自官方错误码文档（尚未用真实 key probe 校准）：
 * 429+1113=欠费（quota）、429+1302=限流；body code 1703=引擎无数据 → 按 no_results 处理。
 */
export const zhipu: ProviderAdapter = {
  name: 'zhipu',
  maxCount: 50,
  includeDomains: 'single',
  note(req: SearchRequest): string | undefined {
    return req.query.length > QUERY_MAX_CHARS ? `zhipu: query truncated to ${QUERY_MAX_CHARS} characters` : undefined;
  },
  async search(req, fetchCount, signal, credential) {
    const body: Record<string, unknown> = {
      search_query: req.query.slice(0, QUERY_MAX_CHARS),
      search_engine: readEnv('ZHIPU_SEARCH_ENGINE') ?? 'search_std',
      count: Math.min(fetchCount, 50),
      search_intent: false,
      content_size: 'medium',
    };
    if (req.freshness) body['search_recency_filter'] = FRESHNESS[req.freshness];
    if (req.includeDomains?.length === 1) body['search_domain_filter'] = req.includeDomains[0];

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'zhipu', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ search_result: z.array(itemSchema) }), 'zhipu');
    return json.search_result.map((it): RawResult => ({
      title: it.title,
      url: it.link,
      content: truncateContent(it.content),
      publishedDate: it.publish_date,
    }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const raw = safeJson(res.bodyText)?.error?.code;
  const code = raw === undefined || raw === null ? undefined : Number(raw);
  const detail = `http_${res.status}${code === undefined || Number.isNaN(code) ? '' : ` ${code}`}`;

  if (res.status === 401 || code === 1000 || code === 1001 || code === 1003) {
    return new ProviderError('zhipu', 'auth_failure', detail);
  }
  if (res.status === 429) {
    if (code === 1113) return new ProviderError('zhipu', 'quota_exhausted', 'http_429 1113_arrears');
    return new ProviderError('zhipu', 'rate_limited', detail); // 1302 等
  }
  if (code === 1701) return new ProviderError('zhipu', 'rate_limited', 'code_1701_concurrency');
  if (code === 1703) return new ProviderError('zhipu', 'no_results', 'code_1703_no_data');
  if (code === 1210) return new ProviderError('zhipu', 'request_error', 'code_1210_bad_param');
  if (code === 1702) return new ProviderError('zhipu', 'server_error', 'code_1702_engine_unavailable', { soft: true });
  return classifyDefault(res, 'zhipu');
}

export const definition: ProviderDefinition = {
  adapter: zhipu,
  label: 'Zhipu 智谱',
  credentialEnv: 'ZHIPU_API_KEY',
  defaultEnabled: false,
  // 纯按量计费、无免费额度：不设 limit，停发依赖 429+1113 欠费错误
  quota: { type: 'one_time' },
};
