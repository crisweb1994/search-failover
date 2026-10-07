import { describe, expect, it } from 'vitest';
import { makeSearchHandler } from '../../src/tools/search.js';
import { configSchema, type AppConfig } from '../../src/config.js';
import { GatewayState } from '../../src/state.js';
import { ResultCache } from '../../src/cache.js';
import type { ProviderEntry } from '../../src/router.js';
import type { RawResult } from '../../src/types.js';

/** D12 配套：as_requested 源的短结果不得入缓存（缓存 key 不含条数，命中只截断不补取） */
describe('search 工具：as_requested 缓存写入规则', () => {
  function build(fetchPolicy: 'cache_fill' | 'as_requested', script: RawResult[][], storeSize: number) {
    const config: AppConfig = configSchema.parse({
      providers: [{ name: 'p1', priority: 1, quota: { type: 'unbounded' }, fetch_policy: fetchPolicy }],
      cache: { store_size: storeSize },
      defaults: { timeout_ms: 1000 },
    });
    let call = 0;
    const adapter = {
      name: 'p1',
      maxCount: 50,
      async search() { return script[Math.min(call++, script.length - 1)] ?? []; },
    };
    const cache = new ResultCache(config.cache);
    const providers: ProviderEntry[] = [{ cfg: config.providers[0]!, adapter: adapter as never }];
    const deps = { config, providers, state: new GatewayState(), cache };
    return { handler: makeSearchHandler(deps), cache, adapter };
  }

  const args = (max: number) => ({ query: 'q', max_results: max, use_cache: true });

  it('as_requested：短结果（< store_size）不写缓存，第二次重查', async () => {
    const { handler, cache, adapter } = build('as_requested', [
      [{ title: 't', url: 'https://x.com/1' }],
      [{ title: 't', url: 'https://x.com/2' }],
    ], 2);
    const first = await handler(args(1));
    expect(JSON.parse(first.content[0].text).meta.cache_hit).toBe(false);
    expect(cache.size).toBe(0); // 1 条 < store_size 2，不写
    const second = await handler(args(1));
    expect(JSON.parse(second.content[0].text).meta.cache_hit).toBe(false);
    expect((adapter as { search: () => Promise<RawResult[]> }).search).toBeTruthy();
  });

  it('as_requested：取满（= store_size）才写缓存', async () => {
    const { handler, cache } = build('as_requested', [
      [{ title: 't', url: 'https://x.com/1' }, { title: 't2', url: 'https://x.com/2' }],
    ], 2);
    await handler(args(2));
    expect(cache.size).toBe(1);
  });

  it('cache_fill：短结果也照常写缓存（现状不变）', async () => {
    const { handler, cache } = build('cache_fill', [
      [{ title: 't', url: 'https://x.com/1' }],
    ], 20);
    await handler(args(1));
    expect(cache.size).toBe(1);
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
