import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult, type SearchRequest } from '../types.js';
import {
  classifyDefault, optionalNumber, optionalString, parseRetryAfterMs, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  url: z.string().min(1),
  // 文档里 title 必有；为空时用 URL 兜底，不因一条结果判整个响应异常
  title: z.string(),
  snippet: optionalString,
  summary: optionalString,
  date: optionalString,
  rerank_score: optionalNumber,
});

const ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
/** query 上限 128 个 Unicode 字符，site:/after: 运算符也算在内 */
const QUERY_MAX_CHARS = 128;
/** 运算符挤占后查询词至少保留的字符数；再短就不发请求，交给下一家 */
const MIN_QUERY_CHARS = 32;
const FRESHNESS_DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 30, year: 365 };

/**
 * 过滤条件只能写进查询词：include_domains → `site:a OR site:b`，freshness → `after:YYYY-MM-DD`，
 * 按文档示例接在查询词后面。运算符必须完整保留，超长时截断查询词；room 是留给查询词的码点数。
 */
function buildQuery(req: SearchRequest, now = Date.now()): { q: string; room: number; truncated: boolean } {
  const ops: string[] = [];
  if (req.includeDomains?.length) ops.push(req.includeDomains.map(d => `site:${d}`).join(' OR '));
  if (req.freshness) {
    ops.push(`after:${new Date(now - FRESHNESS_DAYS[req.freshness] * 86_400_000).toISOString().slice(0, 10)}`);
  }
  const suffix = ops.map(op => ` ${op}`).join('');
  const room = QUERY_MAX_CHARS - [...suffix].length;
  const chars = [...req.query];
  if (chars.length <= room) return { q: req.query + suffix, room, truncated: false };
  return { q: chars.slice(0, Math.max(0, room)).join('').trimEnd() + suffix, room, truncated: true };
}

/**
 * DeepSeek Search（自研搜索引擎，2026-10-17 开放）。错误体是 OpenAI 兼容格式：
 * 402=余额不足（与模型调用共用余额）；429=账号级 QPS 限制（不区分 key）；401 的 message 带 key 末 4 位，不写进 detail。
 * 不开 need_content：summary 实测已有 1.5k–4.6k 字（文档写 600–800），全文会让响应体过大。
 * 几乎总有结果：必然无结果的 probe 查询也返回了 8 条低分（rerank_score < 0.3）结果。
 */
export const deepseek: ProviderAdapter = {
  name: 'deepseek',
  maxCount: 50,
  includeDomains: 'native',
  note(req: SearchRequest): string | undefined {
    const { room, truncated } = buildQuery(req);
    return truncated ? `deepseek: query truncated to ${room} characters` : undefined;
  },
  async search(req, fetchCount, signal, credential) {
    const { q, room, truncated } = buildQuery(req);
    if (truncated && room < MIN_QUERY_CHARS) {
      throw new ProviderError('deepseek', 'request_error',
        `site:/after: operators leave only ${Math.max(0, room)} of ${QUERY_MAX_CHARS} query characters`);
    }
    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, count: fetchCount }),
    }, 'deepseek', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ results: z.array(itemSchema) }), 'deepseek');
    return json.results.map((it): RawResult => {
      // summary 通常远长于 snippet，但实测有 summary 只剩一行、snippet 却有几千字的：取更长的一个
      const summary = it.summary?.trim();
      const snippet = it.snippet?.trim();
      const content = truncateContent(summary && snippet && snippet.length > summary.length ? snippet : summary);
      return {
        title: it.title.trim() || it.url,
        url: it.url,
        snippet: content ? undefined : snippet || undefined,
        content,
        score: it.rerank_score,
        publishedDate: it.date,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('deepseek', 'auth_failure', 'http_401');
  if (res.status === 402) return new ProviderError('deepseek', 'quota_exhausted', 'http_402 insufficient_balance');
  if (res.status === 429) {
    return new ProviderError('deepseek', 'rate_limited', 'http_429', { retryAfterMs: parseRetryAfterMs(res.headers) });
  }
  if (res.status === 400) {
    // 参数错误的 message 会指明字段，如 "'count' must be between 1 and 50"
    const message = safeJson(res.bodyText)?.error?.message;
    return new ProviderError('deepseek', 'request_error', `http_400 ${message ? String(message).slice(0, 120) : ''}`.trim());
  }
  return classifyDefault(res, 'deepseek');
}

export const definition: ProviderDefinition = {
  adapter: deepseek,
  label: 'DeepSeek',
  credentialEnv: 'DEEPSEEK_API_KEY',
  defaultEnabled: false,
  // 2026-10-18 api-docs.deepseek.com/guides/search：按成功请求计费（$0.75/千次，空结果和失败不计），
  // 没有免费额度：不设 limit，停发依赖 402 余额不足。
  quota: { type: 'one_time' },
  extraDefaults: { local_qps: 5 }, // 官方账号级 5 QPS
};
