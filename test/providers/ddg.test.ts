import { describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { duckduckgo, parseHtml } from '../../src/providers/ddg.js';

const server = useMsw();

const PAGE = `
<html><body>
<div class="result results_links">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx">Result &amp; One</a>
  </h2>
  <a class="result__snippet" href="#">Snippet &lt;one&gt;</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="https://example.org/b?x=1">Result Two</a>
  </h2>
  <a class="result__snippet" href="#">Snippet two</a>
</div>
</body></html>`;

const call = () => duckduckgo.search({ query: 'q', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(2000));

describe('DDG adapter 契约（限流=202 异常页，封禁=403/challenge）', () => {
  it('正常：uddg 解包 + 直连锚点 + snippet 按序 zip + 实体解码', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () => new HttpResponse(PAGE, { headers: { 'Content-Type': 'text/html' } })));
    const results = await call();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ title: 'Result & One', url: 'https://example.com/a?utm_source=x', snippet: 'Snippet <one>' });
    expect(results[1]).toMatchObject({ title: 'Result Two', url: 'https://example.org/b?x=1', snippet: 'Snippet two' });
  });

  it('无 result__a 的页面 → []（真实空结果）', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () =>
      new HttpResponse('<html><body><p>no results here</p></body></html>', { headers: { 'Content-Type': 'text/html' } })));
    expect(await call()).toEqual([]);
  });

  it('HTTP 202 异常页 → rate_limited（DDG 的限流不是 429！）', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () => new HttpResponse('anomaly', { status: 202 })));
    await expectProviderError(call(), 'rate_limited');
  });

  it('200 但内容是 challenge 页 → rate_limited 且建议 6h 冷却（不得误判 no_results）', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () =>
      new HttpResponse('<html><body>If this persists, please complete the CAPTCHA challenge</body></html>', {
        headers: { 'Content-Type': 'text/html' },
      })));
    const err = await expectProviderError(call(), 'rate_limited');
    expect(err.retryAfterMs).toBe(6 * 3600 * 1000);
  });

  it('403 → rate_limited 6h', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () => new HttpResponse('forbidden', { status: 403 })));
    const err = await expectProviderError(call(), 'rate_limited');
    expect(err.retryAfterMs).toBe(6 * 3600 * 1000);
  });

  it('500 → server_error', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', () => new HttpResponse(null, { status: 500 })));
    await expectProviderError(call(), 'server_error');
  });

  it('超时 → timeout', async () => {
    server.use(http.post('https://html.duckduckgo.com/html/', async () => {
      await delay(3000);
      return new HttpResponse(PAGE, { headers: { 'Content-Type': 'text/html' } });
    }));
    await expectProviderError(
      duckduckgo.search({ query: 'x', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(120)), 'timeout');
  });

  it('parseHtml：去重与非 http 链接过滤', () => {
    const html = PAGE + `
      <a class="result__a" href="https://example.com/a">Dup URL</a>
      <a class="result__a" href="javascript:void(0)">JS link</a>`;
    const results = parseHtml(html, 20);
    expect(results).toHaveLength(2); // 重复 URL 合并，javascript: 跳过
  });
});
