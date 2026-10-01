import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { serper } from '../../src/providers/serper.js';

/**
 * 契约 fixture 为文档推断结构（provider-expansion-spec §3.3，官方无文档页，
 * 字段来自 playground/第三方口径）——待 scripts/probe.mts 实测后校准（D16）。
 */
const server = useMsw();
beforeAll(() => { process.env['SERPER_API_KEY'] = 'test-key'; });

const URL_API = 'https://google.serper.dev/search';

const OK = {
  organic: [
    { title: 'Google 结果', link: 'https://example.com/a', snippet: 'snippet text', date: '2026-09-01', position: 1 },
    { title: '无日期结果', link: 'https://example.com/b', snippet: 's2', position: 2 },
  ],
  knowledgeGraph: { title: '应被丢弃' },
  relatedSearches: [{ query: 'x' }],
};

const call = (over: Record<string, unknown> = {}) =>
  serper.search({ query: 'q', maxResults: 8, useCache: false, ...over } as never, 20, AbortSignal.timeout(2000));

describe('serper adapter 契约', () => {
  it('正常：organic 的 link→url、date→publishedDate；knowledgeGraph 等丢弃', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Google 结果', url: 'https://example.com/a', snippet: 'snippet text', publishedDate: '2026-09-01' });
    expect(results[1]?.publishedDate).toBeUndefined();
  });

  it('单域名拼 site: 前缀；多域名不拼并 note 降级', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    await call({ includeDomains: ['github.com'] });
    expect(body['q']).toBe('site:github.com q');

    expect(serper.note?.({ query: 'q', maxResults: 8, includeDomains: ['a.com', 'b.com'], useCache: false } as never))
      .toContain('多域名');
    await call({ includeDomains: ['a.com', 'b.com'] });
    expect(body['q']).toBe('q');
  });

  it('freshness day → tbs=qdr:d；num 封顶 100（20 恒为 1 credit）', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    await call({ freshness: 'day' });
    expect(body['tbs']).toBe('qdr:d');
    expect(body['num']).toBe(20);
  });

  it('空结果 → []', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json({ organic: [] })));
    expect(await call()).toEqual([]);
  });

  it('401 → auth_failure；402 → quota_exhausted（一次性 credit，无 resetAt）；429 → rate_limited', async () => {
    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 401 })));
    await expectProviderError(call(), 'auth_failure');

    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 402 })));
    const quotaErr = await expectProviderError(call(), 'quota_exhausted');
    expect(quotaErr.resetAtMs).toBeUndefined();

    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 429 })));
    await expectProviderError(call(), 'rate_limited');
  });

  it('500 → server_error', async () => {
    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });
});
