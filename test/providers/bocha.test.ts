import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { bocha } from '../../src/providers/bocha.js';

const server = useMsw();

const OK_BODY = {
  code: 200,
  data: {
    webPages: {
      value: [
        {
          name: '博查结果一',
          url: 'https://example.com/a',
          snippet: '短摘要',
          summary: '这是一段很长的网页摘要，会填充到 content 字段并被截断到 2000 字符以内',
          datePublished: '2026-09-01',
        },
      ],
    },
  },
};

beforeAll(() => { process.env['BOCHA_API_KEY'] = 'test-key'; });

const call = () => bocha.search({ query: '测试', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(2000));

describe('博查 adapter 契约', () => {
  it('正常：解析 title/url/snippet/content/publishedDate', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () => HttpResponse.json(OK_BODY)));
    const results = await call();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: '博查结果一', url: 'https://example.com/a', publishedDate: '2026-09-01' });
    expect(results[0]?.content).toContain('网页摘要');
    expect(results[0]?.snippet).toBeUndefined();
  });

  it('没有 summary（或全空白）时保留来源自带的 snippet，不返回空 content', async () => {
    for (const summary of [undefined, '   ']) {
      server.use(http.post('https://api.bochaai.com/v1/web-search', () => HttpResponse.json({
        code: 200,
        data: { webPages: { value: [{ name: '博查结果二', url: 'https://example.com/b', snippet: '短摘要', summary }] } },
      })));
      const [result] = await call();
      expect(result?.snippet).toBe('短摘要');
      expect(result?.content).toBeUndefined();
    }
  });

  it('403 余额不足 → quota_exhausted（不是 auth！）', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () =>
      new HttpResponse(JSON.stringify({ code: 403, msg: 'You do not have enough money' }), { status: 403 })));
    const err = await expectProviderError(call(), 'quota_exhausted');
    expect(err.detail).toContain('enough money');
  });

  it('401 → auth_failure', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () =>
      new HttpResponse(JSON.stringify({ msg: 'Invalid API KEY' }), { status: 401 })));
    await expectProviderError(call(), 'auth_failure');
  });

  it('429 → rate_limited（retryAfterMs 缺省交由 state 层 60s）', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () =>
      new HttpResponse(JSON.stringify({ msg: 'You have reached the request limit' }), { status: 429 })));
    const err = await expectProviderError(call(), 'rate_limited');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('500 → server_error', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });

  it('400 → request_error（不屏蔽来源）', async () => {
    server.use(http.post('https://api.bochaai.com/v1/web-search', () =>
      new HttpResponse(JSON.stringify({ msg: 'Missing parameter query' }), { status: 400 })));
    await expectProviderError(call(), 'request_error');
  });

});
