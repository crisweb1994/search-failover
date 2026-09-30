import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { exa } from '../../src/providers/exa.js';

const server = useMsw();
beforeAll(() => { process.env['EXA_API_KEY'] = 'test-key'; });

const OK = {
  results: [
    { title: 'Exa Result', url: 'https://example.com/e', publishedDate: '2026-08-01T00:00:00Z', text: 'y'.repeat(3000) },
  ],
};

const call = () => exa.search({ query: 'q', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(2000));

describe('Exa adapter 契约', () => {
  it('正常：text→content 截断 2000，snippet=前 300 字', async () => {
    server.use(http.post('https://api.exa.ai/search', () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(1);
    expect(results[0]?.content?.length).toBe(2000);
    expect(results[0]?.snippet?.length).toBe(300);
    expect(results[0]?.publishedDate).toBe('2026-08-01T00:00:00Z');
  });

  it('请求体：freshness→startPublishedDate，includeDomains 透传，type=fast', async () => {
    let captured: any;
    server.use(http.post('https://api.exa.ai/search', async ({ request }) => {
      captured = await request.json();
      return HttpResponse.json({ results: [] });
    }));
    await exa.search(
      { query: 'q', maxResults: 8, freshness: 'week', includeDomains: ['docs.rs'], useCache: false },
      20, AbortSignal.timeout(2000));
    expect(captured.includeDomains).toEqual(['docs.rs']);
    expect(captured.type).toBe('fast');
    const days = (Date.now() - Date.parse(captured.startPublishedDate)) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it('空结果 → []', async () => {
    server.use(http.post('https://api.exa.ai/search', () => HttpResponse.json({ results: [] })));
    expect(await call()).toEqual([]);
  });

  it('402 → quota_exhausted（一次性 credit，resetAt 由 state 用 quota_retry_s）', async () => {
    server.use(http.post('https://api.exa.ai/search', () =>
      new HttpResponse(JSON.stringify({ error: 'out of credits', tag: 'INSUFFICIENT_CREDITS' }), { status: 402 })));
    const err = await expectProviderError(call(), 'quota_exhausted');
    expect(err.resetAtMs).toBeUndefined();
  });

  it('401 → auth_failure；429 → rate_limited；503 → server_error', async () => {
    server.use(http.post('https://api.exa.ai/search', () => new HttpResponse(null, { status: 401 })));
    await expectProviderError(call(), 'auth_failure');

    server.use(http.post('https://api.exa.ai/search', () => new HttpResponse(null, { status: 429 })));
    await expectProviderError(call(), 'rate_limited');

    server.use(http.post('https://api.exa.ai/search', () => new HttpResponse(null, { status: 503 })));
    await expectProviderError(call(), 'server_error');
  });

  it('超时 → timeout', async () => {
    server.use(http.post('https://api.exa.ai/search', async () => {
      await delay(3000);
      return HttpResponse.json(OK);
    }));
    await expectProviderError(
      exa.search({ query: 'x', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(120)), 'timeout');
  });
});
