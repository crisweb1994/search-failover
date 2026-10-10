import { z } from 'zod';
import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  content: z.string().nullish().transform(v => v ?? undefined),
  snippet: z.string().nullish().transform(v => v ?? undefined),
  date: z.string().nullish().transform(v => v ?? undefined),
  rerank_score: z.number().nullish().transform(v => v ?? undefined),
});

const ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const QUERY_MAX_UNITS = 72; // 官方口径：query ≤72 单位，汉字计 2

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/;

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
 * 完整分类未公开（provider-expansion-spec §3.2）——429 双语义按 rate_limited
 * 保守处理（短冷却，下一次错误自修正），待 probe 校准。
 */
export const qianfan: ProviderAdapter = {
  name: 'qianfan',
  maxCount: 50,
  note(req: SearchRequest): string | undefined {
    const notes: string[] = [];
    if (countUnits(req.query) > QUERY_MAX_UNITS) notes.push(`qianfan: query 超 ${QUERY_MAX_UNITS} 单位（汉字计 2）已截断`);
    if (req.freshness === 'day') notes.push('qianfan: day 时间过滤不支持，已忽略');
    return notes.length ? notes.join('；') : undefined;
  },
  async search(req, fetchCount, signal) {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: truncateByUnits(req.query, QUERY_MAX_UNITS) }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: Math.min(fetchCount, 50) }],
    };

    // day 不发送未经验证的日期范围，明确提示降级。
    if (req.freshness && req.freshness !== 'day') body['search_recency_filter'] = req.freshness;
    if (req.includeDomains?.length) {
      // 原生多域名白名单（≤100 站点）
      body['search_filter'] = { match: { site: req.includeDomains } };
    }

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyFor('qianfan') ?? ''}`,
        'Content-Type': 'application/json',
      },
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
        score: typeof it.rerank_score === 'number' ? it.rerank_score : undefined,
        publishedDate: it.date ?? undefined,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  const body = safeJson(res.bodyText);
  const code = body?.code ?? body?.error?.code;
  const detail = typeof code !== 'undefined' ? `code_${code}` : '';

  if (res.status === 401) return new ProviderError('qianfan', 'auth_failure', `http_401 ${detail}`.trim());
  if (res.status === 429) return new ProviderError('qianfan', 'rate_limited', `http_429 ${detail}`.trim());
  if (res.status === 400) return new ProviderError('qianfan', 'request_error', `http_400 ${detail}`.trim());
  return classifyDefault(res, 'qianfan');
}
