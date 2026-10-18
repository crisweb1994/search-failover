import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildSearchInput, fitOutputBudget, makeSearchHandler, type SearchArgs } from '../../src/tools/search.js';
import { makeStatusHandler } from '../../src/tools/status.js';
import { cacheKey } from '../../src/cache.js';
import type { RawResult, SearchRequest, SearchResult } from '../../src/types.js';
import { cfg, testRuntime } from '../helpers.js';

const payload = (out: { content: { text: string }[] }) => JSON.parse(out.content[0]!.text);

describe('web_search：按需缓存', () => {
  function build(script: RawResult[][], input: Record<string, unknown> = {}, debug = false) {
    let call = 0;
    const search = vi.fn(async (_req: SearchRequest, _count: number, _signal: AbortSignal) => script[call++] ?? []);
    const rt = testRuntime([{ name: 'exa', maxCount: 100, includeDomains: 'native', search }], input, { debug });
    return { handler: makeSearchHandler(rt), rt, search };
  }
  const args = (max: number, over: Partial<SearchArgs> = {}): SearchArgs => ({ query: 'q', max_results: max, use_cache: true, ...over });
  const rows = (count: number, prefix = 'r'): RawResult[] =>
    Array.from({ length: count }, (_, i) => ({ title: `${prefix}${i}`, url: `https://x.com/${prefix}${i}` }));

  it('短结果也缓存，同参数第二次不调用上游、不计数', async () => {
    const { handler, rt, search } = build([rows(2)]);
    const cold = payload(await handler(args(8)));
    const warm = payload(await handler(args(8)));
    expect(cold.meta.cache_hit).toBe(false);
    expect(warm.meta.cache_hit).toBe(true);
    expect(warm.results).toEqual(cold.results);
    expect(warm.results).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![1]).toBe(8);
    expect(rt.state.used('exa', rt.providers[0]!.cfg)).toBe(1);
  });

  it('3 条与 8 条分别缓存，重复请求各自命中', async () => {
    const { handler, rt, search } = build([rows(3), rows(8)]);
    expect(payload(await handler(args(3))).meta.cache_hit).toBe(false);
    expect(payload(await handler(args(8))).meta.cache_hit).toBe(false);
    const three = payload(await handler(args(3)));
    const eight = payload(await handler(args(8)));
    expect(three.meta.cache_hit).toBe(true);
    expect(eight.meta.cache_hit).toBe(true);
    expect(three.results).toHaveLength(3);
    expect(eight.results).toHaveLength(8);
    expect(search.mock.calls.map(c => c[1])).toEqual([3, 8]);
    expect(rt.cache.size).toBe(2);
  });

  it('上游超量结果截断后才缓存', async () => {
    const { handler, rt, search } = build([rows(10)]);
    const cold = payload(await handler(args(8)));
    const warm = payload(await handler(args(8)));
    expect(search).toHaveBeenCalledTimes(1);
    expect(cold.results).toHaveLength(8);
    expect(warm.results).toEqual(cold.results);
    expect(rt.cache.get(cacheKey('q', 8, undefined, undefined))).toHaveLength(8);
  });

  it.each(['use_cache=false', 'provider', 'disabled'])('%s 绕过读写，不覆盖已有缓存', async mode => {
    const { handler, rt, search } = build([rows(1, 'cached'), rows(1, 'fresh')], {}, mode === 'provider');
    await handler(args(8));
    const stats = { hits: rt.cache.hits, misses: rt.cache.misses };
    if (mode === 'disabled') rt.config.cache.enabled = false;
    const fresh = payload(await handler(args(8, { use_cache: mode !== 'use_cache=false', provider: mode === 'provider' ? 'exa' : undefined })));
    expect(fresh.meta.cache_hit).toBe(false);
    expect(fresh.results[0].title).toBe('fresh0');
    expect({ hits: rt.cache.hits, misses: rt.cache.misses }).toEqual(stats);
    rt.config.cache.enabled = true;
    const cached = payload(await handler(args(8)));
    expect(cached.meta.cache_hit).toBe(true);
    expect(cached.results[0].title).toBe('cached0');
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('非调试模式忽略 provider 参数，照常走兜底和缓存', async () => {
    const { handler, search } = build([rows(1)]);
    await handler(args(8));
    const out = payload(await handler(args(8, { provider: 'missing' })));
    expect(out.meta.cache_hit).toBe(true);
    expect(out.meta.note).toBeUndefined();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('adapter 返回时已取消的非空结果不进入缓存', async () => {
    const { handler, rt, search } = build([]);
    const controller = new AbortController();
    search.mockImplementationOnce(async () => { controller.abort(); return rows(1); });
    await expect(handler(args(8), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(rt.cache.size).toBe(0);
    expect(rt.state.checkBlocked('exa')).toBeNull();
    expect(rt.state.used('exa', rt.providers[0]!.cfg)).toBe(1);
  });
});

describe('工具错误语义、降级说明与 status', () => {
  function setup(outcome: RawResult[] | Error) {
    const adapter = {
      name: 'duckduckgo', maxCount: 20, includeDomains: 'none' as const,
      async search() { if (outcome instanceof Error) throw outcome; return outcome; },
    };
    const rt = testRuntime([{ cfg: cfg('duckduckgo', { quota: { type: 'one_time', limit: 1 } }), adapter }]);
    return { rt, handler: makeSearchHandler(rt) };
  }
  const args: SearchArgs = { query: 'q', max_results: 8, use_cache: true };

  it('合法空结果 isError=false；全失败、额度跳过、无来源 isError=true', async () => {
    const empty = setup([]);
    expect((await empty.handler(args)).isError).toBe(false);
    expect(empty.rt.cache.size).toBe(0);
    expect((await empty.handler(args)).isError).toBe(true); // 已用完本地额度
    expect((await setup(new Error('network')).handler(args)).isError).toBe(true);
    const none = payload(await makeSearchHandler({ ...empty.rt, providers: [] })(args));
    expect(none.meta.fallback_chain).toEqual([expect.objectContaining({ provider: 'gateway', outcome: 'no_provider' })]);
  });

  it('配置错误：每次调用都返回 isError 和具体位置', async () => {
    const { rt } = setup([{ title: 't', url: 'https://x.test' }]);
    const out = await makeSearchHandler({ ...rt, configError: 'config.json: providers.0.quota: unknown field "limt"' })(args);
    expect(out.isError).toBe(true);
    expect(payload(out).meta.fallback_chain[0]).toMatchObject({ outcome: 'config_error', detail: expect.stringContaining('limt') });
  });

  it('冷请求与缓存命中给出同样的降级说明（含 query 截断），命中不消耗请求数', async () => {
    const { rt, handler } = setup([{ title: 't', url: 'https://x.test' }]);
    const longArgs = { ...args, query: 'x'.repeat(401), include_domains: ['a.test'] };
    const cold = payload(await handler(longArgs));
    const warm = payload(await handler(longArgs));
    expect(warm.meta.cache_hit).toBe(true);
    expect(warm.meta.note).toBe(cold.meta.note);
    expect(warm.meta.note).toContain('include_domains is not supported');
    expect(warm.meta.note).toContain('query truncated');
    expect(rt.state.used('duckduckgo', rt.providers[0]!.cfg)).toBe(1);
  });

  it('status：本地额度用完显示 blocked(quota_local)；不在链里的来源列在后面', async () => {
    const { rt, handler } = setup([]);
    await handler(args);
    const status = payload(await makeStatusHandler(rt)());
    expect(status.providers[0]).toMatchObject({ name: 'duckduckgo', in_chain: true, state: 'blocked(quota_local)', used_requests: 1, quota_warning: true });
    expect(status.providers[0]).not.toHaveProperty('used_this_month');
    expect(status.providers.find((p: { name: string }) => p.name === 'bocha')).toMatchObject({ in_chain: false, state: 'unconfigured', credential_env: 'BOCHA_API_KEY' });
    expect(status.config).toEqual({ source: null, error: null, warnings: [] });
    expect(status.network).toEqual({ proxy: null });
  });
});

describe('输入归一化：常见写法直接接受，确实非法才报错', () => {
  const schema = z.object(buildSearchInput(testRuntime()));
  const parse = (over: Record<string, unknown>) => schema.safeParse({ query: 'q', ...over });

  it('include_domains：URL、site:、通配、大小写和尾点都归一成主机名；单个字符串也接受', () => {
    const out = schema.parse({
      query: ' q ',
      include_domains: ['https://Docs.RS/tokio?x=1', 'site:example.com', '*.python.org', 'Docs.Example.com.', '例子.中国'],
    });
    expect(out).toMatchObject({ query: 'q', include_domains: ['docs.rs', 'example.com', 'python.org', 'docs.example.com', 'xn--fsqu00a.xn--fiqs8s'] });
    expect(schema.parse({ query: 'q', include_domains: 'docs.rs' }).include_domains).toEqual(['docs.rs']);
    for (const bad of ['', 'a b', 'a.com OR b.com', 'x:foo', 'javascript:alert(1)']) {
      expect(parse({ include_domains: [bad] }).success, bad).toBe(false);
    }
  });

  it('max_results / freshness / use_cache 宽松转换', () => {
    expect(schema.parse({ query: 'q' })).toMatchObject({ max_results: 8, use_cache: true });
    expect(schema.parse({ query: 'q', max_results: '5', freshness: ' Week ', use_cache: 'false' }))
      .toMatchObject({ max_results: 5, freshness: 'week', use_cache: false });
    expect(schema.parse({ query: 'q', max_results: 99 }).max_results).toBe(20);
    expect(schema.parse({ query: 'q', max_results: 0 }).max_results).toBe(1);
    expect(schema.parse({ query: 'q', max_results: 2.6 }).max_results).toBe(3);
    for (const over of [{ query: '  ' }, { max_results: 'many' }, { freshness: 'decade' }]) expect(parse(over).success).toBe(false);
  });

  it('客户端把没填的可选参数传成 null 时当作没传', () => {
    expect(schema.parse({ query: 'q', max_results: null, freshness: null, include_domains: null, use_cache: null }))
      .toEqual({ query: 'q', max_results: 8, use_cache: true });
  });

  it('provider 参数只在调试模式出现', () => {
    expect(Object.keys(buildSearchInput(testRuntime()))).not.toContain('provider');
    expect(Object.keys(buildSearchInput(testRuntime([], {}, { debug: true })))).toContain('provider');
  });
});

describe('输出总量预算', () => {
  const item = (len: number, field: 'content' | 'snippet' = 'content'): SearchResult =>
    ({ title: 't', url: `https://x.com/${len}`, provider: 'p', [field]: 'x'.repeat(len) });
  const textLength = (r: SearchResult) => (r.content ?? r.snippet ?? '').length;

  it('未超预算原样返回', () => {
    const results = [item(100), item(200)];
    expect(fitOutputBudget(results, 1000)).toEqual({ results, trimmed: false });
  });

  it('超预算时短的保留原文，剩余预算平分给长的；总量不超过预算', () => {
    const { results, trimmed } = fitOutputBudget([item(100), item(5000), item(3000, 'snippet')], 2100);
    expect(trimmed).toBe(true);
    expect(results.map(textLength)).toEqual([100, 1000, 1000]);
    expect(results[1]!.content!.endsWith('…')).toBe(true);
    expect(results[2]!.snippet!.endsWith('…')).toBe(true);
    expect(results.map(textLength).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2100);
  });

  it('handler 截断时在 note 里说明，缓存里保留完整正文', async () => {
    const search = vi.fn(async () => [{ title: 'a', url: 'https://a.test', content: 'y'.repeat(800) }]);
    const rt = testRuntime([{ name: 'exa', maxCount: 20, includeDomains: 'native', search }], { defaults: { max_output_chars: 300 } });
    const out = payload(await makeSearchHandler(rt)({ query: 'q', max_results: 8, use_cache: true }));
    expect(out.results[0].content).toHaveLength(300);
    expect(out.meta.note).toContain('content trimmed to fit 300 characters');
    expect(rt.cache.get(cacheKey('q', 8, undefined, undefined))![0]!.content).toHaveLength(800);
  });
});
