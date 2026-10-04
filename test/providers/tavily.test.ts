import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { tavily } from '../../src/providers/tavily.js';

const server = useMsw();
beforeAll(() => { process.env['TAVILY_API_KEY'] = 'test-key'; });

const OK = {
  results: [
    {
      title: 'Tavily Result',
      url: 'https://example.com/t',
      content: 'x'.repeat(500) + ' chunk2 content',
      score: 0.87,
      published_date: '2026-09-01',
    },
  ],
};

const call = (freshness?: 'day') =>
  tavily.search({ query: 'q', maxResults: 8, freshness, useCache: false }, 20, AbortSignal.timeout(2000));

describe('Tavily adapter 契约', () => {
  it('正常：snippet=content 前 300 字，score/published_date 透传', async () => {
    server.use(http.post('https://api.tavily.com/search', () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(1);
    expect(results[0]?.snippet?.length).toBe(300);
    expect(results[0]?.score).toBe(0.87);
    expect(results[0]?.publishedDate).toBe('2026-09-01');
  });

  it('请求体：freshness→time_range，include_domains 透传', async () => {
    let captured: any;
    server.use(http.post('https://api.tavily.com/search', async ({ request }) => {
      captured = await request.json();
      return HttpResponse.json({ results: [] });
    }));
    await tavily.search(
      { query: 'q', maxResults: 8, freshness: 'day', includeDomains: ['docs.rs'], useCache: false },
      20, AbortSignal.timeout(2000));
    expect(captured.time_range).toBe('day');
    expect(captured.include_domains).toEqual(['docs.rs']);
    expect(captured.search_depth).toBe('basic');
  });

  it('空结果 → []', async () => {
    server.use(http.post('https://api.tavily.com/search', () => HttpResponse.json({ results: [] })));
    expect(await call()).toEqual([]);
  });

  it('429 + Retry-After 头 → rate_limited 且提取 retryAfterMs', async () => {
    server.use(http.post('https://api.tavily.com/search', () =>
      new HttpResponse(JSON.stringify({ detail: 'rate limited' }), { status: 429, headers: { 'Retry-After': '60' } })));
    const err = await expectProviderError(call(), 'rate_limited');
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('432 / 433 → quota_exhausted（resetAt 留空由 state 按月度重置点算）', async () => {
    for (const status of [432, 433]) {
      server.use(http.post('https://api.tavily.com/search', () =>
        new HttpResponse(JSON.stringify({ detail: 'Plan limit exceeded' }), { status })));
      const err = await expectProviderError(call(), 'quota_exhausted');
      expect(err.resetAtMs).toBeUndefined();
    }
  });

  it('401 → auth_failure；422 → request_error；500 → server_error', async () => {
    server.use(http.post('https://api.tavily.com/search', () => new HttpResponse(null, { status: 401 })));
    await expectProviderError(call(), 'auth_failure');

    server.use(http.post('https://api.tavily.com/search', () =>
      new HttpResponse(JSON.stringify({ detail: [{ loc: ['body', 'query'] }] }), { status: 422 })));
    await expectProviderError(call(), 'request_error');

    server.use(http.post('https://api.tavily.com/search', () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });

  it('超时 → timeout', async () => {
    server.use(http.post('https://api.tavily.com/search', async () => {
      await delay(3000);
      return HttpResponse.json(OK);
    }));
    await expectProviderError(
      tavily.search({ query: 'x', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(120)), 'timeout');
  });
});
