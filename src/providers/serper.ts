import { z } from 'zod';
import { ProviderError, type Freshness, type ProviderAdapter, type RawResult } from '../types.js';
import {
  classifyDefault, optionalString, rawRequest, parseSuccess,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  title: z.string().min(1),
  link: z.string().min(1),
  snippet: optionalString,
  date: optionalString,
});

const ENDPOINT = 'https://google.serper.dev/search';
const FRESHNESS: Record<Freshness, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

/**
 * Serper.dev（Google SERP）。官方无独立文档页，字段与错误码来自
 * playground/第三方实测口径：402=credit 耗尽（一次性，无重置点）、401=key 无效、429=QPS 限制。
 */
export const serper: ProviderAdapter = {
  name: 'serper',
  maxCount: 100,
  includeDomains: 'single',
  async search(req, fetchCount, signal, credential) {
    const q = req.includeDomains?.length === 1 ? `site:${req.includeDomains[0]} ${req.query}` : req.query;
    // 计费分档待实际核实；本地按请求尝试计数，不等同 credits
    const body: Record<string, unknown> = { q, num: Math.min(fetchCount, 100) };
    if (req.freshness) body['tbs'] = FRESHNESS[req.freshness];

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-KEY': credential ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 'serper', signal);

    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, z.object({ organic: z.array(itemSchema) }), 'serper');
    return json.organic.map((it): RawResult => ({
      title: it.title,
      url: it.link,
      snippet: it.snippet || undefined,
      publishedDate: it.date,
    }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 401) return new ProviderError('serper', 'auth_failure', 'http_401');
  if (res.status === 402) return new ProviderError('serper', 'quota_exhausted', 'http_402_credits_exhausted');
  if (res.status === 429) return new ProviderError('serper', 'rate_limited', 'http_429');
  return classifyDefault(res, 'serper');
}

export const definition: ProviderDefinition = {
  adapter: serper,
  label: 'Serper',
  credentialEnv: 'SERPER_API_KEY',
  defaultEnabled: false,
  quota: { type: 'one_time', limit: 2500 },
  extraDefaults: { local_qps: 1 }, // 免费档 1 QPS 为第三方口径，保守起步
};
