import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { qianfan } from '../../src/providers/qianfan.js';

/**
 * 基于官方接口示例的构造 fixture，并非真实 probe 响应。
 * https://cloud.baidu.com/doc/qianfan/s/2mh4su4uy （2026-10-04 核对）
 */
const server = useMsw();
beforeAll(() => { process.env['QIANFAN_API_KEY'] = 'test-key'; });

const URL_API = 'https://qianfan.baidubce.com/v2/ai_search/web_search';

const OK = {
  references: [
    { type: 'web', title: '百度结果', url: 'https://example.com/a', snippet: '摘要', content: '正文', date: '2026-09-01', rerank_score: 0.87 },
    { type: 'web', title: '无分数结果', url: 'https://example.com/b', snippet: 's2', content: 'c2' },
  ],
};

const call = (over: Record<string, unknown> = {}) =>
  qianfan.search({ query: 'q', maxResults: 8, useCache: false, ...over } as never, 20, AbortSignal.timeout(2000));

describe('qianfan adapter 契约', () => {
  it('正常：title/url/content（有正文时不给 snippet）/rerank_score→score/date→publishedDate', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: '百度结果', url: 'https://example.com/a', content: '正文', score: 0.87, publishedDate: '2026-09-01',
    });
    expect(results.map(r => r.snippet)).toEqual([undefined, undefined]);
    expect(results[1]?.score).toBeUndefined();
  });

  it('没有正文时保留来源自带的 snippet', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json({ references: [
      { type: 'web', title: 't', url: 'https://example.com/c', snippet: '只有短摘要' },
    ] })));
    const [result] = await call();
    expect(result?.snippet).toBe('只有短摘要');
    expect(result?.content).toBeUndefined();
  });

  it('messages 单轮结构；query 按官方单位口径（汉字计 2）截断并 note', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    expect(qianfan.note?.({ query: '词'.repeat(40), maxResults: 8, useCache: false } as never)).toContain('已截断');
    expect(qianfan.note?.({ query: 'q', maxResults: 8, useCache: false } as never)).toBeUndefined();

    await call();
    expect(body['messages']).toEqual([{ role: 'user', content: 'q' }]);
    expect(body['search_source']).toBe('baidu_search_v2');
    expect(body['resource_type_filter']).toEqual([{ type: 'web', top_k: 20 }]);

    await call({ query: '字'.repeat(80) }); // 160 单位 → 截到 72 单位 = 36 个汉字
    expect([...body['messages'][0]['content'] as string]).toHaveLength(36);
  });

  it('freshness：week → recency 枚举；day → 明确降级；多域名原生白名单', async () => {
    let body: any;
    server.use(http.post(URL_API, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(OK);
    }));
    await call({ freshness: 'week' });
    expect(body['search_recency_filter']).toBe('week');

    await call({ freshness: 'day', includeDomains: ['a.com', 'b.com'] });
    expect(body['search_recency_filter']).toBeUndefined();
    expect(qianfan.note?.({ query: 'q', maxResults: 8, useCache: false, freshness: 'day' })).toContain('已忽略');
    expect(body['search_filter']).toEqual({
      match: { site: ['a.com', 'b.com'] },
    });
  });

  it('401 → auth_failure；429 → rate_limited（保守，双语义待 probe 拆分）', async () => {
    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ request_id: 'x', code: 401, message: ' unauthorized' }), { status: 401 })));
    await expectProviderError(call(), 'auth_failure');

    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ request_id: 'x', code: 17, message: 'rate' }), { status: 429 })));
    await expectProviderError(call(), 'rate_limited');
  });

  it('400 → request_error；500 → server_error', async () => {
    server.use(http.post(URL_API, () =>
      new HttpResponse(JSON.stringify({ request_id: 'x', code: 400, message: 'bad' }), { status: 400 })));
    await expectProviderError(call(), 'request_error');

    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });
});
