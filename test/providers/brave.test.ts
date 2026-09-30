import { describe, expect, it, beforeAll } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { brave, parseAge } from '../../src/providers/brave.js';

const server = useMsw();
beforeAll(() => { process.env['BRAVE_API_KEY'] = 'test-key'; });

const URL_BASE = 'https://api.search.brave.com/res/v1/web/search';

const OK = {
  web: {
    results: [
      { title: 'Brave Result', url: 'https://example.com/b', description: 'snippet text', page_age: '2026-09-10T00:00:00Z' },
      { title: 'Brave Relative', url: 'https://example.com/c', description: 'no page_age', age: '2 days ago' },
    ],
  },
};

const call = (includeDomains?: string[]) =>
  brave.search({ query: 'q', maxResults: 8, includeDomains, useCache: false }, 20, AbortSignal.timeout(2000));

describe('Brave adapter 契约', () => {
  it('正常：description→snippet，page_age 优先，age 相对时间解析', async () => {
    server.use(http.get(URL_BASE, () => HttpResponse.json(OK)));
    const results = await call();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Brave Result', snippet: 'snippet text', publishedDate: '2026-09-10T00:00:00Z' });
    expect(results[1]?.publishedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('单域名过滤拼 site:，多域名降级忽略', async () => {
    let capturedUrl = '';
    server.use(http.get(URL_BASE, async ({ request }) => {
      capturedUrl = request.url;
      return HttpResponse.json(OK);
    }));
    await call(['github.com']);
    expect(decodeURIComponent(capturedUrl)).toContain('site:github.com');

    await call(['a.com', 'b.com']);
    expect(decodeURIComponent(capturedUrl)).not.toContain('site:');
  });

  it('空结果 → []', async () => {
    server.use(http.get(URL_BASE, () => HttpResponse.json({ web: { results: [] } })));
    expect(await call()).toEqual([]);
  });

  it('429 + RATE_LIMITED → rate_limited，冷却取 X-RateLimit-Reset 第一桶', async () => {
    server.use(http.get(URL_BASE, () =>
      new HttpResponse(JSON.stringify({ error: { code: 'RATE_LIMITED' } }), {
        status: 429,
        headers: { 'X-RateLimit-Reset': '1, 183945' },
      })));
    const err = await expectProviderError(call(), 'rate_limited');
    expect(err.retryAfterMs).toBe(1000);
  });

  it('429 + QUOTA_LIMITED → quota_exhausted，resetAt=now+第二桶秒数', async () => {
    server.use(http.get(URL_BASE, () =>
      new HttpResponse(JSON.stringify({ error: { code: 'QUOTA_LIMITED' } }), {
        status: 429,
        headers: { 'X-RateLimit-Reset': '1, 183945' },
      })));
    const err = await expectProviderError(call(), 'quota_exhausted');
    expect(err.resetAtMs).toBeGreaterThan(Date.now() + 183_000_000); // 第二桶 183945s
    expect(err.resetAtMs).toBeLessThan(Date.now() + 185_000_000);
  });

  it('422 + SUBSCRIPTION_TOKEN_INVALID → auth_failure（不是 401！）', async () => {
    server.use(http.get(URL_BASE, () =>
      new HttpResponse(JSON.stringify({ error: { code: 'SUBSCRIPTION_TOKEN_INVALID' } }), { status: 422 })));
    await expectProviderError(call(), 'auth_failure');
  });

  it('422 + VALIDATION → soft server_error', async () => {
    server.use(http.get(URL_BASE, () =>
      new HttpResponse(JSON.stringify({ error: { code: 'VALIDATION' } }), { status: 422 })));
    const err = await expectProviderError(call(), 'server_error');
    expect(err.soft).toBe(true);
  });

  it('500 → server_error', async () => {
    server.use(http.get(URL_BASE, () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });

  it('超时 → timeout', async () => {
    server.use(http.get(URL_BASE, async () => {
      await delay(3000);
      return HttpResponse.json(OK);
    }));
    await expectProviderError(
      brave.search({ query: 'x', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(120)), 'timeout');
  });

  it('parseAge 相对时间解析与失败', () => {
    expect(parseAge('3 hours ago')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseAge('nonsense')).toBeUndefined();
    expect(parseAge(undefined)).toBeUndefined();
  });
});
