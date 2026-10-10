import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { zhipu } from '../../src/providers/zhipu.js';

/**
 * 契约 fixture 为文档推断结构（provider-expansion-spec §3.1），
 * 待 scripts/probe.mts 实测后校准（D16：fixture 应来自真实响应）。
 */
const server = useMsw();
beforeAll(() => { process.env['ZHIPU_API_KEY'] = 'test-key'; });

const URL_API = 'https://open.bigmodel.cn/api/paas/v4/web_search';

const OK = {
  search_result: [
    { title: '智谱结果', link: 'https://example.com/a', content: '正文摘要内容', publish_date: '2026-09-01' },
    { title: '无日期结果', link: 'https://example.com/b', content: 'c2' },
  ],
};

const call = (over: Record<string, unknown> = {}) =>
  zhipu.search({ query: 'q', maxResults: 8, useCache: false, ...over } as never, 20, AbortSignal.timeout(2000));

describe('zhipu adapter 契约', () => {
  it('正常：link→url，content 直传且不重复给 snippet，publish_date 直传', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: '智谱结果', url: 'https://example.com/a', content: '正文摘要内容', publishedDate: '2026-09-01' });
    expect(results[0]?.snippet).toBeUndefined();
    expect(results[1]?.publishedDate).toBeUndefined();
  });

  it('query 超 70 字符截断并 note；单域名传 search_domain_filter，多域名 note 降级', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    const long = '长'.repeat(80);
    expect(zhipu.note?.({ query: long, maxResults: 8, includeDomains: ['a.com'], useCache: false } as never))
      .toContain('已截断');
    expect(zhipu.note?.({ query: 'q', maxResults: 8, includeDomains: ['a.com', 'b.com'], useCache: false } as never))
      .toContain('多域名');

    await call({ query: long, includeDomains: ['a.com'] });
    expect(body['search_query'].length).toBe(70);
    expect(body['search_domain_filter']).toBe('a.com');
  });

  it('freshness day → search_recency_filter=oneDay；count 封顶 50', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    await call({ freshness: 'day' });
    expect(body['search_recency_filter']).toBe('oneDay');
    expect(body['count']).toBe(20);
    expect(body['search_engine']).toBe('search_std');
  });

  it('429 + 1302 → rate_limited；429 + 1113 → quota_exhausted（欠费）', async () => {
    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ error: { code: '1302', message: 'Rate limit reached' } }), { status: 429 })));
    await expectProviderError(call(), 'rate_limited');

    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ error: { code: '1113', message: '账户欠费' } }), { status: 429 })));
    await expectProviderError(call(), 'quota_exhausted');
  });

  it('401 / body code 1000 → auth_failure', async () => {
    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ error: { code: '1000' } }), { status: 401 })));
    await expectProviderError(call(), 'auth_failure');
  });

  it('body code 1703（引擎无数据）→ no_results；1210 → request_error', async () => {
    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ error: { code: '1703' } }), { status: 400 })));
    await expectProviderError(call(), 'no_results');

    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ error: { code: '1210' } }), { status: 400 })));
    await expectProviderError(call(), 'request_error');
  });

  it('500 → server_error', async () => {
    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });
});
