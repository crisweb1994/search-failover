import { z } from 'zod';
import { ProviderError, type ProviderAdapter, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, optionalNumber, optionalString, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  content: optionalString,
  snippet: optionalString,
  date: optionalString,
  rerank_score: optionalNumber,
});

const ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const QUERY_MAX_UNITS = 72; // 官方口径：query ≤72 单位，汉字计 2

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

export function countUnits(s: string): number {
  let u = 0;
  for (const ch of s) u += CJK.test(ch) ? 2 : 1;
  return u;
}

/** 按官方单位口径截断（汉字计 2），保证截断后 ≤ max 单位 */
export function truncateByUnits(s: string, max: number): string {
  const chars = [...s];
  let u = 0;
  for (let i = 0; i < chars.length; i++) {
    u += CJK.test(chars[i]!) ? 2 : 1;
    if (u > max) return chars.slice(0, i).join('');
  }
  return s;
}

/**
 * 百度千帆 ai_search。文档只给出通用 code/message 错误体，欠费/限流/鉴权的
 * 完整分类未公开——429 双语义按 rate_limited 保守处理，待 probe 校准。
 */
export const qianfan: ProviderAdapter = {
  name: 'qianfan',
  maxCount: 50,
  includeDomains: 'native',
  note(req: SearchRequest): string | undefined {
    const notes: string[] = [];
    if (countUnits(req.query) > QUERY_MAX_UNITS) notes.push(`qianfan: query truncated to ${QUERY_MAX_UNITS} units (CJK counts as 2)`);
    if (req.freshness === 'day') notes.push('qianfan: freshness=day is not supported and was ignored');
    return notes.length ? notes.join('; ') : undefined;
  },
  async search(req, fetchCount, signal, credential) {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: truncateByUnits(req.query, QUERY_MAX_UNITS) }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: Math.min(fetchCount, 50) }],
    };

    // day 不发送未经验证的日期范围，明确提示降级。
    if (req.freshness && req.freshness !== 'day') body['search_recency_filter'] = req.freshness;
    // 原生多域名白名单（≤100 站点）
    if (req.includeDomains?.length) body['search_filter'] = { match: { site: req.includeDomains } };

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'qianfan', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ references: z.array(z.object({ type: z.string() }).passthrough()) }), 'qianfan');
    const items = json.references.filter(it => it.type === 'web').map(it => {
      const parsed = itemSchema.safeParse(it);
      if (!parsed.success) throw new ProviderError('qianfan', 'server_error', 'invalid_response');
      return parsed.data;
    });
    return items.map((it): RawResult => {
      const content = truncateContent(it.content);
      return {
        title: it.title,
        url: it.url,
        snippet: content ? undefined : it.snippet || undefined,
        content,
        score: it.rerank_score,
        publishedDate: it.date,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const body = safeJson(res.bodyText);
  const code = body?.code ?? body?.error?.code;
  const detail = code !== undefined && code !== null ? ` code_${code}` : '';

  if (res.status === 401) return new ProviderError('qianfan', 'auth_failure', `http_401${detail}`);
  if (res.status === 429) return new ProviderError('qianfan', 'rate_limited', `http_429${detail}`);
  if (res.status === 400) return new ProviderError('qianfan', 'request_error', `http_400${detail}`);
  return classifyDefault(res, 'qianfan');
}

export const definition: ProviderDefinition = {
  adapter: qianfan,
  label: 'Baidu Qianfan 百度千帆',
  credentialEnv: 'QIANFAN_API_KEY',
  defaultEnabled: false,
  quota: { type: 'monthly', limit: 1500, reset_day: 1 },
  extraDefaults: { local_qps: 1 }, // 官方默认 1 QPS
};
