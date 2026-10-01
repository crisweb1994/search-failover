import { apiKeyFor } from '../credentials.js';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, rawRequest, safeJson, snippetFrom, truncateContent,
  type HttpResponseInfo, type ProviderAdapter,
} from './types.js';

const ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
const QUERY_MAX_UNITS = 72; // 官方口径：query ≤72 单位，汉字计 2

/** week/month/year 有 search_recency_filter 枚举；day 用 page_time 精确区间表达 */
const RECENCY: Record<string, string> = { week: 'week', month: 'month', year: 'year' };

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
    return countUnits(req.query) > QUERY_MAX_UNITS
      ? `qianfan: query 超 ${QUERY_MAX_UNITS} 单位（汉字计 2）已截断`
      : undefined;
  },
  async search(req, fetchCount, signal) {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: truncateByUnits(req.query, QUERY_MAX_UNITS) }],
      search_source: 'baidu_search_v2',
      resource_type_filter: { web: { top_k: Math.min(fetchCount, 50) } },
    };

    const filter: Record<string, unknown> = {};
    if (req.freshness) {
      if (req.freshness === 'day') {
        // day 无枚举：用 page_time 精确区间（probe 校准项，语法被推翻则整体降级忽略）
        filter['range'] = { page_time: { gte: 'now-1d' } };
      } else {
        body['search_recency_filter'] = RECENCY[req.freshness];
      }
    }
    if (req.includeDomains?.length) {
      // 原生多域名白名单（≤100 站点）
      filter['match'] = { site: req.includeDomains };
    }
    if (Object.keys(filter).length) body['search_filter'] = filter;

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyFor('qianfan') ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 'qianfan', signal);

    if (res.status !== 200) throw classify(res);
    const json = safeJson(res.bodyText);
    // 响应容器字段文档未明示（probe 校准项）：按候选路径依次尝试
    const items: any[] = json?.search_result ?? json?.web_pages?.value ?? json?.webpages ?? [];
    return items
      .filter(it => it?.title && it?.url)
      .map((it): RawResult => {
        const content = truncateContent(it.content);
        return {
          title: String(it.title),
          url: String(it.url),
          snippet: snippetFrom(content, it.snippet ? String(it.snippet) : undefined),
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
  if (res.status === 400) return new ProviderError('qianfan', 'server_error', `http_400 ${detail}`.trim(), { soft: true });
  return classifyDefault(res, 'qianfan');
}
