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
    const deps = { config, allProviders: config.providers, providers, state: new GatewayState(), cache };
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
