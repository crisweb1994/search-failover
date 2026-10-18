import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult } from '../types.js';
import {
  classifyDefault, optionalString, rawRequest, safeJson, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  summary: optionalString,
  snippet: optionalString,
  datePublished: optionalString,
  dateLastCrawled: optionalString,
});

const pagesSchema = z.object({ value: z.array(itemSchema) });

/**
 * Bing 兼容格式：没有结果时 data 里不带 webPages（博查官方 MCP 同样按"无结果"处理），
 * 但 data 本身必须在，`{}` 之类的响应仍然算异常，不能静默变成空结果。
 */
const responseSchema = z.union([
  z.object({ data: z.object({ webPages: pagesSchema.nullish() }) }),
  z.object({ webPages: pagesSchema }),
]);

const ENDPOINT = 'https://api.bochaai.com/v1/web-search';
const FRESHNESS: Record<Freshness, string> = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };

/** 博查。错误分类注意：403 是余额不足（quota），401 才是 key 无效。 */
export const bocha: ProviderAdapter = {
  name: 'bocha',
  maxCount: 50,
  includeDomains: 'none',
  async search(req, fetchCount, signal, credential) {
    const body: Record<string, unknown> = { query: req.query, count: fetchCount, summary: true };
    if (req.freshness) body['freshness'] = FRESHNESS[req.freshness];
    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'bocha', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, responseSchema, 'bocha');
    const items = ('data' in json ? json.data.webPages?.value : json.webPages.value) ?? [];
    return items.map((it): RawResult => {
      const content = truncateContent(it.summary);
      return {
        title: it.name,
        url: it.url,
        snippet: content ? undefined : it.snippet || undefined,
        content,
        publishedDate: it.datePublished ?? it.dateLastCrawled,
      };
    });
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('bocha', 'auth_failure', `http_401 ${bodyMsg(res)}`.trim());
  if (res.status === 403) return new ProviderError('bocha', 'quota_exhausted', `http_403 ${bodyMsg(res)}`.trim());
  if (res.status === 429) return new ProviderError('bocha', 'rate_limited', `http_429 ${bodyMsg(res)}`.trim());
  return classifyDefault(res, 'bocha');
}

function bodyMsg(res: HttpResponseInfo): string {
  const body = safeJson(res.bodyText);
  const msg = body?.msg ?? body?.message;
  return msg ? String(msg).slice(0, 120) : '';
}

export const definition: ProviderDefinition = {
  adapter: bocha,
  label: 'Bocha 博查',
  credentialEnv: 'BOCHA_API_KEY',
  defaultEnabled: true,
  quota: { type: 'monthly', limit: 1000, reset_day: 1 },
};
