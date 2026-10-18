import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { searchEndpoint, searxng } from '../../src/providers/searxng.js';

/** 响应结构按 SearXNG /search?format=json 的公开输出构造，尚未接入真实实例 probe */
const server = useMsw();
const BASE = 'http://searx.test:8080';

const OK = {
  query: 'q',
  number_of_results: 0,
  results: [
    { url: 'https://example.com/a', title: 'Result A', content: 'snippet a', publishedDate: '2026-09-01T00:00:00', score: 2.5, engine: 'bing' },
    { url: 'https://example.com/b', title: '  ', content: null, publishedDate: null, engine: 'duckduckgo' },
  ],
  unresponsive_engines: [],
};

const call = (over: Record<string, unknown> = {}, base: string = BASE) =>
  searxng.search({ query: 'q', maxResults: 8, useCache: false, ...over } as never, 20, AbortSignal.timeout(2000), base);

describe('SearXNG adapter 契约', () => {
  it('正常：content→snippet，空标题用 URL 兜底，score/publishedDate 透传', async () => {
    let url = '';
    server.use(http.get(`${BASE}/search`, ({ request }) => { url = request.url; return HttpResponse.json(OK); }));
    const results = await call();
    expect(results).toEqual([
      { title: 'Result A', url: 'https://example.com/a', snippet: 'snippet a', score: 2.5, publishedDate: '2026-09-01T00:00:00' },
      { title: 'https://example.com/b', url: 'https://example.com/b', snippet: undefined, score: undefined, publishedDate: undefined },
    ]);
    expect(new URL(url).searchParams.get('format')).toBe('json');
  });

  it('请求参数：单域名拼 site:，freshness→time_range；实例地址可带子路径', async () => {
    let url = '';
    server.use(http.get('https://example.org/searxng/search', ({ request }) => { url = request.url; return HttpResponse.json(OK); }));
    await call({ includeDomains: ['docs.rs'], freshness: 'week' }, 'https://example.org/searxng');
    const params = new URL(url).searchParams;
    expect(params.get('q')).toBe('site:docs.rs q');
    expect(params.get('time_range')).toBe('week');
  });

  it('结果按 fetchCount 截断', async () => {
    const many = { results: Array.from({ length: 30 }, (_, i) => ({ url: `https://x.test/${i}`, title: `t${i}` })) };
    server.use(http.get(`${BASE}/search`, () => HttpResponse.json(many)));
    expect(await searxng.search({ query: 'q', maxResults: 5, useCache: false }, 5, AbortSignal.timeout(2000), BASE)).toHaveLength(5);
  });

  it('空结果：引擎都正常 → []；所有引擎失败 → server_error（不能当成没搜到）', async () => {
    server.use(http.get(`${BASE}/search`, () => HttpResponse.json({ results: [], unresponsive_engines: [] })));
    expect(await call()).toEqual([]);
    server.use(http.get(`${BASE}/search`, () => HttpResponse.json({ results: [], unresponsive_engines: [['google', 'timeout'], ['bing', 'CAPTCHA']] })));
    const err = await expectProviderError(call(), 'server_error');
    expect(err.detail).toBe('all engines failed (google: timeout; bing: CAPTCHA)');
    expect(err.soft).toBe(true);
  });

  it('403（实例没开 json 格式）→ request_error 并提示怎么改；429 → rate_limited', async () => {
    server.use(http.get(`${BASE}/search`, () => new HttpResponse('Forbidden', { status: 403 })));
    expect((await expectProviderError(call(), 'request_error')).detail).toContain('search.formats');
    server.use(http.get(`${BASE}/search`, () => new HttpResponse('Too Many Requests', { status: 429 })));
    await expectProviderError(call(), 'rate_limited');
  });

  it('SEARXNG_URL 不是 http(s) 地址 → request_error，不发请求', async () => {
    for (const base of ['localhost:8080', 'ftp://x.test', '']) {
      expect((await expectProviderError(call({}, base), 'request_error')).detail).toContain('SEARXNG_URL');
    }
    expect(searchEndpoint('http://h:1/sub')?.toString()).toBe('http://h:1/sub/search');
    expect(searchEndpoint('http://h:1/sub/')?.toString()).toBe('http://h:1/sub/search');
  });
});
