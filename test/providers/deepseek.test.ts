import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { deepseek } from '../../src/providers/deepseek.js';

/**
 * fixture 以官方示例为底（https://api-docs.deepseek.com/guides/search），按 2026-10-18 的 live probe
 * （scripts/probe.mts deepseek）校准：空标题、summary 比 snippet 短、401/400 错误体，以及 128 字符按码点计数，都来自真实响应。
 */
const server = useMsw();

const URL_API = 'https://api.deepseek.com/v1/tools/search';

const OK = {
  results: [
    {
      rerank_score: 2.4,
      title: 'DeepSeek V4 model released',
      url: 'https://example.com/deepseek-v4',
      snippet: 'DeepSeek V4 is now available, with tool calling and long-context support.',
      summary: 'DeepSeek has released the V4 model. The release adds improved tool calling and long-context support for agent workflows.',
      content: '',
      site_name: 'Example News',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    },
    {
      rerank_score: 0.8, title: '', url: 'https://example.com/untitled', snippet: '只有短摘要', summary: '   ',
      content: '', site_name: null, site_icon: null, date: null, authority: -1,
    },
    {
      rerank_score: 0.57, title: 'TESTING.md', url: 'https://example.com/testing.md#3', snippet: `Load Tests ${'x'.repeat(3000)}`,
      summary: '**Monitoring & Alerts:', content: '', site_name: 'GitHub', site_icon: null, date: null, authority: 3,
    },
  ],
};

const call = (over: Record<string, unknown> = {}) =>
  deepseek.search({ query: 'q', maxResults: 8, useCache: false, ...over } as never, 20, AbortSignal.timeout(2000), 'test-key');

/** 截获请求体，返回空结果 */
function captureBody() {
  const captured: { body?: any; count: number } = { count: 0 };
  server.use(http.post(URL_API, async ({ request }) => {
    captured.count += 1;
    captured.body = await request.json();
    return HttpResponse.json({ results: [] });
  }));
  return captured;
}

describe('DeepSeek adapter 契约', () => {
  it('正常：summary→content（不重复给 snippet），rerank_score→score，date→publishedDate；凭据走 Bearer 头', async () => {
    let auth = '';
    server.use(http.post(URL_API, ({ request }) => {
      auth = request.headers.get('authorization') ?? '';
      return HttpResponse.json(OK);
    }));
    const results = await call();
    expect(auth).toBe('Bearer test-key');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      title: 'DeepSeek V4 model released', url: 'https://example.com/deepseek-v4',
      score: 2.4, publishedDate: '2026-06-01T00:00:00+00:00',
    });
    expect(results[0]?.content).toContain('agent workflows');
    expect(results[0]?.snippet).toBeUndefined();
  });

  it('summary 全空白时保留 snippet；空标题用 URL 兜底；null 字段视同缺失', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json(OK)));
    const [, result] = await call();
    expect(result).toMatchObject({ title: 'https://example.com/untitled', snippet: '只有短摘要', score: 0.8 });
    expect(result?.content).toBeUndefined();
    expect(result?.publishedDate).toBeUndefined();
  });

  it('summary 比 snippet 短时取 snippet 作 content（实测有 22 字 summary 配 3113 字 snippet）', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json(OK)));
    const [, , result] = await call();
    expect(result?.content).toMatch(/^Load Tests x+$/);
    expect(result?.content).toHaveLength(2000);
    expect(result?.snippet).toBeUndefined();
  });

  it('请求体只有 query 与 count（不开 need_content）；没有过滤条件时查询词原样发送', async () => {
    const captured = captureBody();
    expect(await call({ query: 'mcp stdio transport' })).toEqual([]);
    expect(captured.body).toEqual({ query: 'mcp stdio transport', count: 20 });
  });

  it('include_domains → site: 用 OR 连接；freshness → after:YYYY-MM-DD', async () => {
    const captured = captureBody();
    await call({ includeDomains: ['github.com', 'huggingface.co'] });
    expect(captured.body.query).toBe('q site:github.com OR site:huggingface.co');

    const dateBefore = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    await call({ freshness: 'week', includeDomains: ['docs.rs'] });
    const dateAfter = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const m = /^q site:docs\.rs after:(\d{4}-\d{2}-\d{2})$/.exec(captured.body.query);
    expect([dateBefore, dateAfter]).toContain(m?.[1]);
  });

  it('查询词按码点计 128 个字符，运算符算在内：超出时截断查询词并 note', async () => {
    const captured = captureBody();
    const long = '搜😀'.repeat(70); // 140 个码点，UTF-16 长度 210
    expect(deepseek.note?.({ query: long, maxResults: 8, useCache: false })).toBe('deepseek: query truncated to 128 characters');
    await call({ query: long });
    expect([...captured.body.query as string]).toHaveLength(128);

    const req = { query: 'x'.repeat(200), maxResults: 8, useCache: false, includeDomains: ['docs.rs'] };
    expect(deepseek.note?.(req)).toBe('deepseek: query truncated to 115 characters');
    await call(req);
    expect(captured.body.query).toBe(`${'x'.repeat(115)} site:docs.rs`);

    expect(deepseek.note?.({ query: 'q', maxResults: 8, useCache: false, includeDomains: ['docs.rs'], freshness: 'day' })).toBeUndefined();
  });

  it('运算符挤得查询词不到 32 个字符 → request_error，不发请求；查询词本身放得下则照常发送', async () => {
    const captured = captureBody();
    const includeDomains = ['docs.python.org', 'developer.mozilla.org', 'stackoverflow.com', 'github.com', 'learn.microsoft.com'];
    const err = await expectProviderError(call({ query: 'python asyncio taskgroup', includeDomains }), 'request_error');
    expect(err.detail).toContain('of 128 query characters');
    expect(captured.count).toBe(0);

    await call({ query: 'asy', includeDomains });
    expect(captured.count).toBe(1);
  });

  it('401 → auth_failure，detail 不带 message 里的 key 末 4 位；402 余额不足 → quota_exhausted（resetAt 留空，由 state 按 quota_retry_s 等待）', async () => {
    server.use(http.post(URL_API, () => HttpResponse.json({ error: {
      message: 'Authentication Fails, Your api key: ****-key is invalid (request_id: 574394a6-6517-4ae3-a06b-c49b2f8227c6)',
      type: 'authentication_error', param: null, code: 'invalid_request_error',
    } }, { status: 401 })));
    expect((await expectProviderError(call(), 'auth_failure')).detail).toBe('http_401');

    server.use(http.post(URL_API, () => HttpResponse.json(
      { error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } },
      { status: 402 })));
    const err = await expectProviderError(call(), 'quota_exhausted');
    expect(err.resetAtMs).toBeUndefined();
  });

  it('429 → rate_limited（有 Retry-After 时提取）；400 → request_error 并带上 message；500 / 504 → server_error', async () => {
    server.use(http.post(URL_API, () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '2' } })));
    expect((await expectProviderError(call(), 'rate_limited')).retryAfterMs).toBe(2000);

    server.use(http.post(URL_API, () => HttpResponse.json({ error: {
      message: "'count' must be between 1 and 50 (request_id: 00f7436c-ac58-4bcd-9225-b647217132b6)",
      type: 'invalid_request_error', param: null, code: 'invalid_request_error',
    } }, { status: 400 })));
    expect((await expectProviderError(call(), 'request_error')).detail)
      .toBe("http_400 'count' must be between 1 and 50 (request_id: 00f7436c-ac58-4bcd-9225-b647217132b6)");

    for (const status of [500, 504]) {
      server.use(http.post(URL_API, () => new HttpResponse(null, { status })));
      await expectProviderError(call(), 'server_error');
    }
  });
});
