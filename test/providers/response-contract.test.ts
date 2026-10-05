import { describe, expect, it } from 'vitest';
import { http, HttpResponse, delay } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { REGISTRY } from '../../src/providers/registry.js';
import { parseRetryAfterMs, parseRateLimitResetBuckets } from '../../src/providers/types.js';

const server = useMsw();
const samples = [
  ['bocha', { data: { webPages: { value: [] } } }, { data: { webPages: { value: [{ name: {}, url: 'https://x.test' }] } } }],
  ['tavily', { results: [] }, { results: [{ title: {}, url: 'https://x.test' }] }],
  ['brave', { web: { results: [] } }, { web: { results: [{ title: {}, url: 'https://x.test' }] } }],
  ['exa', { results: [] }, { results: [{ title: {}, url: 'https://x.test' }] }],
  ['zhipu', { search_result: [] }, { search_result: [{ title: {}, link: 'https://x.test' }] }],
  ['serper', { organic: [] }, { organic: [{ title: {}, link: 'https://x.test' }] }],
  ['qianfan', { references: [] }, { references: [{ type: 'web', title: {}, url: 'https://x.test' }] }],
] as const;

describe('成功响应不能静默退化为空结果', () => {
  it.each(samples)('%s: 合法空数组、坏 JSON、缺容器、坏条目', async (name, empty, badItem) => {
    const call = () => REGISTRY[name]!.adapter.search({ query: 'q', maxResults: 8, useCache: false }, 8, AbortSignal.timeout(2000));
    server.use(http.all('*', () => HttpResponse.json(empty)));
    expect(await call()).toEqual([]);
    for (const text of ['<html>gateway error</html>', '{', '{}', JSON.stringify(badItem)]) {
      server.use(http.all('*', () => HttpResponse.text(text)));
      await expect(call()).rejects.toMatchObject({ type: 'server_error', detail: text.startsWith('{') && text !== '{' ? 'invalid_response' : 'invalid_json' });
    }
  });
  it('千帆只消费 references 内的 web 条目', async () => {
    server.use(http.all('*', () => HttpResponse.json({ references: [
      { type: 'image', image: {} }, { type: 'web', title: 'ok', url: 'https://x.test' },
    ] })));
    const out = await REGISTRY.qianfan!.adapter.search({ query: 'q', maxResults: 8, useCache: false }, 8, AbortSignal.timeout(2000));
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('ok');
  });
  it('Retry-After 非法/负值缺失，0 和过去的有效日期仍有效', () => {
    for (const v of ['-1', 'Infinity', 'NaN', 'nonsense', '', '1e999']) {
      expect(parseRetryAfterMs(new Headers({ 'retry-after': v }))).toBeUndefined();
    }
    expect(parseRateLimitResetBuckets(new Headers({ 'x-ratelimit-reset': ', -1' }))).toEqual({ first: undefined, second: undefined });
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '0' }))).toBe(0);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': 'Wed, 01 Jan 2020 00:00:00 GMT' }))).toBe(0);
  });
});

// 同一契约逐源验证 signal 传递；真实 HTTP body 超时另由 cancellation.test.ts 覆盖。
it.each(['bocha', 'tavily', 'brave', 'exa', 'duckduckgo'])('%s: 超时归类为 timeout', async name => {
  server.use(http.all('*', async () => { await delay(3000); return new HttpResponse(); }));
  await expectProviderError(REGISTRY[name]!.adapter.search(
    { query: 'x', maxResults: 8, useCache: false }, 20, AbortSignal.timeout(120)), 'timeout');
});
