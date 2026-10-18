import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult } from '../types.js';
import {
  classifyDefault, optionalNumber, optionalString, rawRequest, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  text: optionalString,
  publishedDate: optionalString,
  score: optionalNumber,
});

const ENDPOINT = 'https://api.exa.ai/search';

/** freshness → 发布时间起点（往前推 N 天的 ISO 8601） */
const FRESHNESS_DAYS: Record<Freshness, number> = { day: 1, week: 7, month: 30, year: 365 };

/** Exa：402=credit 耗尽；本地窗口不代表账户余额或真实账期 */
export const exa: ProviderAdapter = {
  name: 'exa',
  maxCount: 100,
  includeDomains: 'native',
  async search(req, fetchCount, signal, credential) {
    const body: Record<string, unknown> = {
      query: req.query,
      numResults: fetchCount,
      type: 'fast',
      contents: { text: { maxCharacters: 2000 } },
    };
    if (req.freshness) {
      body['startPublishedDate'] = new Date(Date.now() - FRESHNESS_DAYS[req.freshness] * 86_400_000).toISOString();
    }
    if (req.includeDomains?.length) body['includeDomains'] = req.includeDomains;

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'exa', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ results: z.array(itemSchema) }), 'exa');
    return json.results.map((it): RawResult => ({
      title: it.title,
      url: it.url,
      content: truncateContent(it.text),
      score: it.score,
      publishedDate: it.publishedDate,
    }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('exa', 'auth_failure', 'http_401');
  if (res.status === 402) return new ProviderError('exa', 'quota_exhausted', 'http_402 out_of_credits');
  if (res.status === 429) return new ProviderError('exa', 'rate_limited', 'http_429');
  return classifyDefault(res, 'exa');
}

export const definition: ProviderDefinition = {
  adapter: exa,
  label: 'Exa',
  credentialEnv: 'EXA_API_KEY',
  defaultEnabled: true,
  // 2026-10-04 exa.ai/pricing：月度 credits；800 仅为本地请求预算。
  quota: { type: 'monthly', limit: 800, reset_day: 1 },
};
