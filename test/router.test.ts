import { describe, expect, it } from 'vitest';
import { runSearch, normalizeUrl, type ProviderEntry } from '../src/router.js';
import { GatewayState } from '../src/state.js';
import { configSchema, providerSchema, defaultProviders, type AppConfig } from '../src/config.js';
import { ProviderError, type ProviderAdapter, type RawResult, type SearchRequest } from '../src/types.js';

/** 脚本化 FakeProvider：按序返回结果或抛错 */
class Fake implements ProviderAdapter {
  name: string;
  maxCount: number;
  calls = 0;
  script: (RawResult[] | Error)[];
  delayMs = 0;
  constructor(name: string, script: (RawResult[] | Error)[], maxCount = 50) {
    this.name = name;
    this.script = script;
    this.maxCount = maxCount;
  }
  async search(_req: SearchRequest, fetchCount: number): Promise<RawResult[]> {
    this.calls++;
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    void fetchCount;
    const step = this.script.shift();
    if (step instanceof Error) throw step;
    return step ?? [];
  }
}

const DEFAULTS = { cooldown_default_s: 60, cooldown_max_s: 3600 };

function mkConfig(over: Record<string, unknown> = {}): AppConfig {
  return configSchema.parse({
    providers: defaultProviders(),
    defaults: { timeout_ms: 5000, total_budget_ms: 5000, ...over },
  });
}

function mkDeps(adapters: Fake[], config = mkConfig()) {
  const state = new GatewayState();
  const providers: ProviderEntry[] = adapters.map(a => ({
    cfg: providerSchema.parse({ name: a.name, priority: adapters.indexOf(a) + 1, quota: { type: 'unbounded' } }),
    adapter: a,
  }));
  return { deps: { providers, state, config }, state };
}

const REQ = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'q', maxResults: 8, useCache: false, ...over });
const err = (type: ConstructorParameters<typeof ProviderError>[1], opts: ConstructorParameters<typeof ProviderError>[3] = {}) =>
  new ProviderError('x', type, 'fake', opts);
const r = (url: string, content?: string): RawResult => ({ title: 't', url, snippet: 's', content });

describe('Router：顺序兜底与错误处置（对应验收 2/4/5/6/10/13）', () => {
  it('首选 429 → 次选胜出；屏蔽期内该源被 skipped（验收 2）', async () => {
    const a = new Fake('p1', [err('rate_limited', { retryAfterMs: 60_000 })]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);

    const out = await runSearch(REQ(), deps);
    expect(out.meta.provider_used).toBe('p2');
    expect(out.meta.fallback_chain[0]).toMatchObject({ provider: 'p1', outcome: 'rate_limited' });
    expect(state.checkBlocked('p1')?.reason).toBe('rate_limited');

    const out2 = await runSearch(REQ(), deps);
    expect(out2.meta.fallback_chain[0]?.outcome).toBe('skipped:rate_limited');
    expect(a.calls).toBe(1); // 屏蔽期内不再请求
  });

  it('配额信号 → 摘到重置点（验收 3）', async () => {
    const a = new Fake('p1', [err('quota_exhausted', { resetAtMs: Date.now() + 3_600_000 })]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.checkBlocked('p1')?.reason).toBe('quota_exhausted');
  });

  it('401 → 长期摘除，status 可见（验收 4）', async () => {
    const a = new Fake('p1', [err('auth_failure')]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.checkBlocked('p1', Date.now() + 365 * 86400_000)?.reason).toBe('auth_failure');
  });

  it('空结果 → 直接切换；不惩罚不屏蔽（验收 5）', async () => {
    const a = new Fake('p1', [[]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    const out = await runSearch(REQ(), deps);
    expect(out.meta.fallback_chain[0]?.outcome).toBe('no_results');
    expect(state.checkBlocked('p1')).toBeNull();
    expect(state.failStreak('p1')).toBe(0);
    expect(out.meta.provider_used).toBe('p2');
  });

  it('timeout → 直接切换，同源恰好 1 次请求、无重试（验收 6，D6 v1.2）', async () => {
    const a = new Fake('p1', [err('timeout'), r('https://never.com')]); // 若发生重试会吃到第二个脚本
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps } = mkDeps([a, b]);
    const out = await runSearch(REQ(), deps);
    expect(a.calls).toBe(1);
    expect(out.meta.provider_used).toBe('p2');
    expect(out.meta.fallback_chain[0]?.outcome).toBe('timeout');
  });

  it('全部故障 → 结构化空结果，不抛错（验收 10）', async () => {
    const adapters = [
      new Fake('p1', [err('rate_limited')]),
      new Fake('p2', [err('quota_exhausted')]),
      new Fake('p3', [err('timeout')]),
      new Fake('p4', [err('server_error')]),
    ];
    const { deps } = mkDeps(adapters);
    const out = await runSearch(REQ(), deps);
    expect(out.results).toEqual([]);
    expect(out.meta.provider_used).toBeNull();
    expect(out.meta.fallback_chain.map(s => s.outcome)).toEqual(['rate_limited', 'quota_exhausted', 'timeout', 'server_error']);
  });

  it('全部 no_results → 空结果 + 完整链', async () => {
    const adapters = [new Fake('p1', [[]]), new Fake('p2', [[]])];
    const { deps } = mkDeps(adapters);
    const out = await runSearch(REQ(), deps);
    expect(out.results).toEqual([]);
    expect(out.meta.fallback_chain.every(s => s.outcome === 'no_results')).toBe(true);
  });

  it('总预算耗尽 → 剩余源 skipped:budget_exhausted 且不请求（验收 13）', async () => {
    const a = new Fake('p1', [[r('https://slow.com')]]); a.delayMs = 120;
    const b = new Fake('p2', [[r('https://never.com')]]);
    const c = new Fake('p3', [[r('https://never.com')]]);
    const config = mkConfig({ total_budget_ms: 80 });
    const { deps } = mkDeps([a, b, c], config);
    const out = await runSearch(REQ(), deps);
    expect(out.meta.provider_used).toBe('p1'); // 第一个慢源成功
    expect(b.calls).toBe(0);
    expect(c.calls).toBe(0);
  });

  it('强制 provider：只路由该源，屏蔽状态照样生效', async () => {
    const a = new Fake('p1', [err('rate_limited', { retryAfterMs: 60_000 })]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps } = mkDeps([a, b]);
    const out = await runSearch(REQ({ provider: 'p1' }), deps);
    expect(out.results).toEqual([]);
    expect(b.calls).toBe(0);
  });

  it('fetchCount = min(store_size, adapter.maxCount)，成功源计数 +1', async () => {
    const a = new Fake('p1', [[]], 10); // maxCount 10 < store_size 20
    const b = new Fake('p2', [[r('https://ok.com')]], 50);
    const config = mkConfig();
    const { deps, state } = mkDeps([a, b], config);
    // 通过包装捕获 fetchCount
    const seen: number[] = [];
    for (const p of deps.providers) {
      const orig = p.adapter.search.bind(p.adapter);
      p.adapter = { ...p.adapter, search: async (req, fc, sig) => { seen.push(fc); return orig(req, fc, sig); } };
    }
    await runSearch(REQ(), deps);
    expect(seen).toEqual([10, 20]);
    expect(state.used('p2')).toBe(1);
  });

  it('同源去重：utm 变体 URL 保留信息更全的一条（验收 8）', async () => {
    const a = new Fake('p1', [[
      r('https://example.com/p?utm_source=x', 'short'),
      { title: 't', url: 'https://example.com/p', snippet: 's', content: 'much longer content wins' },
      r('https://other.com/1'),
    ]]);
    const { deps } = mkDeps([a]);
    const out = await runSearch(REQ(), deps);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]?.content).toBe('much longer content wins');
  });

  it('降级说明进入 meta.note', async () => {
    const a: Fake & { note?: unknown } = new Fake('p1', [[r('https://ok.com')]]);
    (a as any).note = (req: SearchRequest) => (req.includeDomains?.length ? 'p1: include_domains 不支持' : undefined);
    const { deps } = mkDeps([a as unknown as Fake]);
    const out = await runSearch(REQ({ includeDomains: ['x.com'] }), deps);
    expect(out.meta.note).toContain('include_domains');
  });
});

describe('normalizeUrl / dedupe 辅助', () => {
  it('规范化：追踪参数剥离、host 小写、默认端口与尾斜杠', () => {
    expect(normalizeUrl('https://Example.COM:443/a?utm_source=x&b=2')).toBe('https://example.com/a?b=2');
    expect(normalizeUrl('http://example.com:80/')).toBe('http://example.com');
    expect(normalizeUrl('https://example.com/path/')).toBe('https://example.com/path/');
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});
