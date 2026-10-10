import { describe, expect, it, vi } from 'vitest';
import { makeSearchHandler } from '../../src/tools/search.js';
import { configSchema, parseConfig } from '../../src/config.js';
import { GatewayState } from '../../src/state.js';
import { cacheKey, ResultCache } from '../../src/cache.js';
import type { ProviderEntry } from '../../src/router.js';
import type { RawResult, SearchRequest } from '../../src/types.js';

describe('search 工具：按需缓存', () => {
  function build(script: RawResult[][], over: Record<string, unknown> = {}) {
    const config = parseConfig({ providers: [{ name: 'exa' }], ...over });
    let call = 0;
    const search = vi.fn(async (_req: SearchRequest, _count: number, _signal: AbortSignal) => script[call++] ?? []);
    const cache = new ResultCache(config.cache);
    const providers: ProviderEntry[] = [{ cfg: config.providers[0]!, adapter: { name: 'exa', maxCount: 100, search } }];
    const deps = { config, providers, state: new GatewayState(), cache };
    return { handler: makeSearchHandler(deps), deps, search };
  }
  const args = (max: number) => ({ query: 'q', max_results: max, use_cache: true });
  const rows = (count: number, prefix = 'r'): RawResult[] =>
    Array.from({ length: count }, (_, i) => ({ title: `${prefix}${i}`, url: `https://x.com/${prefix}${i}` }));
  const payload = (out: { content: { text: string }[] }) => JSON.parse(out.content[0]!.text);

  it('默认 Exa 的短结果也缓存，同参数第二次不调用上游、不计数', async () => {
    const { handler, deps, search } = build([rows(2)]);
    const cold = payload(await handler(args(8)));
    const warm = payload(await handler(args(8)));
    expect(cold.meta.cache_hit).toBe(false);
    expect(warm.meta.cache_hit).toBe(true);
    expect(warm.results).toEqual(cold.results);
    expect(warm.results).toHaveLength(2);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![1]).toBe(8);
    expect(deps.state.used('exa', deps.config.providers[0]!)).toBe(1);
  });

  it('3 条与 8 条分别缓存，重复请求各自命中', async () => {
    const { handler, deps, search } = build([rows(3), rows(8)]);
    expect(payload(await handler(args(3))).meta.cache_hit).toBe(false);
    expect(payload(await handler(args(8))).meta.cache_hit).toBe(false);
    const three = payload(await handler(args(3)));
    const eight = payload(await handler(args(8)));
    expect(three.meta.cache_hit).toBe(true);
    expect(eight.meta.cache_hit).toBe(true);
    expect(three.results).toHaveLength(3);
    expect(eight.results).toHaveLength(8);
    expect(search.mock.calls.map(call => call[1])).toEqual([3, 8]);
    expect(deps.cache.size).toBe(2);
  });

  it('旧 store_size 不限制取数，上游超量结果截断后才缓存', async () => {
    const { handler, deps, search } = build([rows(10)], {
      providers: [{ name: 'exa', fetch_policy: 'cache_fill' }], cache: { store_size: 2 },
    });
    const cold = payload(await handler(args(8)));
    const warm = payload(await handler(args(8)));
    expect(search.mock.calls[0]![1]).toBe(8);
    expect(search).toHaveBeenCalledTimes(1);
    expect(cold.results).toHaveLength(8);
    expect(warm.results).toEqual(cold.results);
    expect(deps.cache.get(cacheKey('q', 8, undefined, undefined))).toEqual(cold.results);
  });

  it.each(['use_cache=false', 'provider', 'disabled'])('%s 绕过读写，不覆盖已有缓存', async mode => {
    const { handler, deps, search } = build([rows(1, 'cached'), rows(1, 'fresh')]);
    await handler(args(8));
    const stats = { hits: deps.cache.hits, misses: deps.cache.misses };
    if (mode === 'disabled') deps.config.cache.enabled = false;
    const bypass = { ...args(8), use_cache: mode !== 'use_cache=false', provider: mode === 'provider' ? 'exa' : undefined };
    const fresh = payload(await handler(bypass));
    expect(fresh.meta.cache_hit).toBe(false);
    expect(fresh.results[0].title).toBe('fresh0');
    expect({ hits: deps.cache.hits, misses: deps.cache.misses }).toEqual(stats);
    deps.config.cache.enabled = true;
    const cached = payload(await handler(args(8)));
    expect(cached.meta.cache_hit).toBe(true);
    expect(cached.results[0].title).toBe('cached0');
    expect(search).toHaveBeenCalledTimes(2);
    expect(deps.state.used('exa', deps.config.providers[0]!)).toBe(2);
  });

  it('adapter 返回时已取消的非空结果不进入缓存', async () => {
    const { handler, deps, search } = build([]);
    const controller = new AbortController();
    search.mockImplementationOnce(async () => { controller.abort(); return rows(1); });
    await expect(handler(args(8), { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(deps.cache.size).toBe(0);
    expect(deps.state.checkBlocked('exa')).toBeNull();
    expect(deps.state.used('exa', deps.config.providers[0]!)).toBe(1);
  });
});

describe('工具错误语义、缓存解释与 status', () => {
  function setup(outcome: RawResult[] | Error) {
    const config = configSchema.parse({ providers: [{ name: 'duckduckgo', quota: { type: 'one_time', limit: 1 } }] });
    const state = new GatewayState();
    const cache = new ResultCache(config.cache);
    const providers = [{ cfg: config.providers[0]!, adapter: {
      name: 'duckduckgo', maxCount: 20,
      note: () => 'duckduckgo: include_domains 不支持，已忽略',
      async search() { if (outcome instanceof Error) throw outcome; return outcome; },
    } }];
    const deps = { config, state, cache, providers };
    return { deps, handler: makeSearchHandler(deps) };
  }
  const args = { query: 'q', max_results: 8, use_cache: true };
  it('合法空结果 isError=false；全失败、额度跳过、无来源 isError=true', async () => {
    const empty = setup([]);
    expect((await empty.handler(args)).isError).toBe(false);
    expect(empty.deps.cache.size).toBe(0);
    expect((await empty.handler(args)).isError).toBe(true); // 已用完本地额度
    expect((await setup(new Error('network')).handler(args)).isError).toBe(true);
    empty.deps.providers = [];
    expect((await makeSearchHandler(empty.deps)(args)).isError).toBe(true);
  });
  it('缓存命中重建降级说明与 query 截断提示，不消耗请求数', async () => {
    const { deps, handler } = setup([{ title: 't', url: 'https://x.test' }]);
    const longArgs = { ...args, query: 'x'.repeat(401), include_domains: ['a.test'] };
    const cold = JSON.parse((await handler(longArgs)).content[0].text);
    const warm = JSON.parse((await handler(longArgs)).content[0].text);
    expect(warm.meta.cache_hit).toBe(true);
    expect(warm.meta.note).toBe(cold.meta.note);
    expect(warm.meta.note).toContain('已忽略');
    expect(warm.meta.note).toContain('已截断');
    expect(deps.state.used('duckduckgo', deps.config.providers[0]!)).toBe(1);
  });
  it('status 本地额度用完显示 blocked，旧字段是同值别名', async () => {
    const { deps, handler } = setup([]);
    await handler(args);
    const { makeStatusHandler } = await import('../../src/tools/status.js');
    const payload = JSON.parse((await makeStatusHandler(deps)()).content[0].text);
    expect(payload.providers[0]).toMatchObject({ state: 'blocked(quota_local)', used_requests: 1, used_this_month: 1, quota_warning: true });
  });
  it('输入拒绝空白 query/provider 和包含操作符或 URL 的域名', async () => {
    const { z } = await import('zod');
    const { searchInput } = await import('../../src/tools/search.js');
    const schema = z.object(searchInput);
    for (const over of [{ query: '  ' }, { provider: '  ' }, ...['', 'a b', 'a.com OR b.com', 'https://a.com', 'x:foo'].map(s => ({ include_domains: [s] }))]) {
      expect(schema.safeParse({ ...args, ...over }).success).toBe(false);
    }
    expect(schema.parse({ ...args, query: ' q ', include_domains: [' docs.example.com '] })).toMatchObject({ query: 'q', include_domains: ['docs.example.com'] });
  });
});
