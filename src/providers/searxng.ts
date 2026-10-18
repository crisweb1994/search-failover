import { z } from 'zod';
import { ProviderError, type ProviderAdapter, type RawResult } from '../types.js';
import {
  classifyDefault, optionalNumber, optionalString, rawRequest, parseSuccess, truncateContent,
  type HttpResponseInfo, type ProviderDefinition,
} from './types.js';

const itemSchema = z.object({
  url: z.string().min(1),
  // 部分引擎给空标题：用 URL 兜底，不因一条结果判整个响应异常
  title: z.string(),
  content: optionalString,
  publishedDate: optionalString,
  score: optionalNumber,
});

const responseSchema = z.object({
  results: z.array(itemSchema),
  unresponsive_engines: z.array(z.unknown()).optional(),
});

/** 自建实例的 /search 地址；SEARXNG_URL 可以带子路径（如 https://example.com/searxng） */
export function searchEndpoint(base: string): URL | undefined {
  try {
    const url = new URL('search', base.endsWith('/') ? base : `${base}/`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * SearXNG（自建元搜索，免 key）。实例需在 settings.yml 的 search.formats 里打开 json，
 * 否则 /search?format=json 返回 403。所有引擎都失败时，SearXNG 仍返回 200 + 空结果 +
 * unresponsive_engines，这种情况按 server_error 处理，不能当成"没搜到"。
 */
export const searxng: ProviderAdapter = {
  name: 'searxng',
  maxCount: 20,
  includeDomains: 'single',
  async search(req, fetchCount, signal, credential) {
    const url = searchEndpoint(credential ?? '');
    if (!url) throw new ProviderError('searxng', 'request_error', 'SEARXNG_URL must be an http(s) URL');
    url.searchParams.set('q', req.includeDomains?.length === 1 ? `site:${req.includeDomains[0]} ${req.query}` : req.query);
    url.searchParams.set('format', 'json');
    // SearXNG 的 time_range 取值与 freshness 同名
    if (req.freshness) url.searchParams.set('time_range', req.freshness);

    const res = await rawRequest(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } }, 'searxng', signal);
    if (res.status !== 200) throw classify(res);
    const json = parseSuccess(res.bodyText, responseSchema, 'searxng');
    if (json.results.length === 0 && json.unresponsive_engines?.length) {
      const engines = json.unresponsive_engines.slice(0, 3).map(e => (Array.isArray(e) ? e.join(': ') : String(e))).join('; ');
      throw new ProviderError('searxng', 'server_error', `all engines failed (${engines})`.slice(0, 200), { soft: true });
    }
    return json.results.slice(0, fetchCount).map((it): RawResult => ({
      title: it.title.trim() || it.url,
      url: it.url,
      snippet: truncateContent(it.content),
      score: it.score,
      publishedDate: it.publishedDate,
    }));
  },
};

function classify(res: HttpResponseInfo): ProviderError {
  if (res.status === 403) {
    return new ProviderError('searxng', 'request_error', 'http_403 (enable "json" in search.formats of the instance settings.yml)');
  }
  if (res.status === 429) return new ProviderError('searxng', 'rate_limited', 'http_429');
  return classifyDefault(res, 'searxng');
}

export const definition: ProviderDefinition = {
  adapter: searxng,
  label: 'SearXNG (self-hosted)',
  credentialEnv: 'SEARXNG_URL',
  defaultEnabled: true,
  quota: { type: 'unbounded' },
};
