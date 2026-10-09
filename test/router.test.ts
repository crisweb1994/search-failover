import { describe, expect, it, vi } from 'vitest';
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
    expect(out.meta.provider_used).toBeNull(); // 超过总预算的结果不再接受
    expect(out.meta.fallback_chain[0]?.outcome).toBe('skipped:budget_exhausted');
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

  it('按需取数，成功源计数 +1', async () => {
    const a = new Fake('p1', [[]], 10); // 该源最多 10 条
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
    expect(seen).toEqual([8, 8]); // useCache=false 按需取数
    expect(state.used('p2', deps.providers[1]!.cfg)).toBe(1);
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

describe('配额软闸门与请求计数（D10/D13）', () => {
  it('D10：used ≥ limit → skipped:quota_local 且不发请求、不屏蔽', async () => {
    const a = new Fake('p1', [[r('https://never.com')]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const state = new GatewayState();
    const cfg = providerSchema.parse({ name: 'p1', priority: 1, quota: { type: 'monthly', limit: 2, reset_day: 1 } });
    state.tryStart('p1', cfg);
    state.tryStart('p1', cfg);
    const providers: ProviderEntry[] = [
      { cfg, adapter: a },
      { cfg: providerSchema.parse({ name: 'p2', priority: 2, quota: { type: 'unbounded' } }), adapter: b },
    ];

    const out = await runSearch(REQ(), { providers, state, config: mkConfig() });
    expect(a.calls).toBe(0);
    expect(out.meta.fallback_chain[0]).toMatchObject({ provider: 'p1', outcome: 'skipped:quota_local', detail: '2/2' });
    expect(out.meta.provider_used).toBe('p2');
    expect(state.checkBlocked('p1')).toBeNull(); // 软闸门不进健康状态
  });

  it('D10：unbounded / 未设 limit 的源不触发闸门', async () => {
    const a = new Fake('p1', [[r('https://ok.com')]]);
    const state = new GatewayState();
    const cfg = providerSchema.parse({ name: 'p1', priority: 1, quota: { type: 'one_time' } }); // 无 limit
    for (let i = 0; i < 10; i++) state.tryStart('p1', cfg);
    const providers: ProviderEntry[] = [{ cfg, adapter: a }];

    const out = await runSearch(REQ(), { providers, state, config: mkConfig() });
    expect(a.calls).toBe(1);
    expect(out.meta.provider_used).toBe('p1');
  });

  it('D13：空结果（no_results 路径）也计数', async () => {
    const a = new Fake('p1', [[]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.used('p1', deps.providers[0]!.cfg)).toBe(1); // 空结果仍 tick
    expect(state.used('p2', deps.providers[1]!.cfg)).toBe(1);
  });


});

describe('准入、取消与健康归因', () => {
  it('健康冷却后本地预算仍拦截；本地窗口重置也不会提前解除健康屏蔽', async () => {
    const clock = vi.spyOn(Date, 'now');
    const before = new Date(2026, 8, 30, 23, 59, 0).getTime();
    try {
      clock.mockReturnValue(before);
      const a = new Fake('p1', [err('quota_exhausted', { resetAtMs: before + 3600_000 })]);
      const { deps, state } = mkDeps([a]);
      const cfg = deps.providers[0]!.cfg;
      cfg.quota = { type: 'monthly', limit: 1, reset_day: 1 };
      await runSearch(REQ(), deps);

      // 新窗口已到，但上游尚未允许恢复。
      clock.mockReturnValue(new Date(2026, 9, 1, 0, 0, 0).getTime());
      const blocked = await runSearch(REQ(), deps);
      expect(blocked.meta.fallback_chain[0]?.outcome).toBe('skipped:quota_exhausted');
      expect(state.used('p1', cfg)).toBe(0);
      expect(a.calls).toBe(1);

      clock.mockReturnValue(before + 3600_000);
      await runSearch(REQ(), deps);
      expect(a.calls).toBe(2);
      // 新窗口预算已用完，即便健康允许也不能再次调用。
      const exhausted = await runSearch(REQ(), deps);
      expect(exhausted.meta.fallback_chain[0]?.outcome).toBe('skipped:quota_local');
      expect(a.calls).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it('月度本地预算和配额错误冷却独立，冷却后再次错误重新等待', async () => {
    const clock = vi.spyOn(Date, 'now');
    const now = new Date(2026, 9, 9, 12).getTime();
    try {
      clock.mockReturnValue(now);
      const a = new Fake('p1', [err('quota_exhausted'), err('quota_exhausted'), [r('https://ok.com')]]);
      const { deps } = mkDeps([a]);
      deps.providers[0]!.cfg.quota = { type: 'monthly', limit: 10, reset_day: 1 };
      deps.providers[0]!.cfg.quota_retry_s = 600;
      await runSearch(REQ(), deps);
      clock.mockReturnValue(now + 599_000);
      expect((await runSearch(REQ(), deps)).meta.fallback_chain[0]?.outcome).toBe('skipped:quota_exhausted');
      expect(a.calls).toBe(1);
      clock.mockReturnValue(now + 600_000);
      await runSearch(REQ(), deps);
      clock.mockReturnValue(now + 1199_000);
      await runSearch(REQ(), deps);
      expect(a.calls).toBe(2);
      clock.mockReturnValue(now + 1200_000);
      expect((await runSearch(REQ(), deps)).meta.provider_used).toBe('p1');
      expect(a.calls).toBe(3);
    } finally { clock.mockRestore(); }
  });

  it.each([
    [2026, 8, 30, 1, 'monthly'],
    [2026, 8, 30, 1, 'one_time'],
    [2026, 8, 29, 31, 'monthly'],
    [2026, 1, 27, 31, 'monthly'],
    [2028, 1, 28, 31, 'monthly'],
    [2026, 9, 14, 15, 'monthly'],
  ] as const)('路由满额跨窗口 %i/%i/%i reset_day=%i %s', async (year, month, day, resetDay, type) => {
    const clock = vi.spyOn(Date, 'now');
    const before = new Date(year, month, day, 23, 59, 59).getTime();
    try {
      clock.mockReturnValue(before);
      const a = new Fake('p1', [[r('https://ok.com')], [r('https://ok.com')]]);
      const { deps } = mkDeps([a]);
      deps.providers[0]!.cfg.quota = { type, limit: 1, reset_day: resetDay };
      await runSearch(REQ(), deps);
      expect((await runSearch(REQ(), deps)).meta.fallback_chain[0]?.outcome).toBe('skipped:quota_local');
      clock.mockReturnValue(before + 1000);
      const out = await runSearch(REQ(), deps);
      expect(a.calls).toBe(type === 'monthly' ? 2 : 1);
      expect(out.meta.provider_used).toBe(type === 'monthly' ? 'p1' : null);
    } finally { clock.mockRestore(); }
  });

  it('limit=1 三个并发请求只批准一个，错误同样消耗预算', async () => {
    const a = new Fake('p1', [err('network')]);
    a.delayMs = 20;
    const { deps, state } = mkDeps([a]);
    deps.providers[0]!.cfg.quota = { type: 'one_time', limit: 1 };
    const results = await Promise.all([0, 1, 2].map(() => runSearch(REQ(), deps)));
    expect(a.calls).toBe(1);
    expect(state.used('p1', deps.providers[0]!.cfg)).toBe(1);
    expect(results.flatMap(r => r.meta.fallback_chain).filter(s => s.outcome === 'skipped:quota_local')).toHaveLength(2);
  });
  it('等待期间被另一请求屏蔽，醒来后不再调用 adapter', async () => {
    const a = new Fake('p1', [err('auth_failure')]);
    a.delayMs = 20;
    const { deps } = mkDeps([a]);
    deps.providers[0]!.cfg.min_interval_ms = 100;
    const [, second] = await Promise.all([runSearch(REQ(), deps), runSearch(REQ(), deps)]);
    expect(a.calls).toBe(1);
    expect(second.meta.fallback_chain[0]?.outcome).toBe('skipped:auth_failure');
  });
  it('参数错误不屏蔽，下一次正常请求仍可执行；合法空结果清除失败阶梯', async () => {
    const a = new Fake('p1', [err('request_error'), []]);
    const { deps, state } = mkDeps([a]);
    state.block('p1', err('network'), deps.providers[0]!.cfg, DEFAULTS, Date.now() - 31_000);
    await runSearch(REQ(), deps);
    expect(state.failStreak('p1')).toBe(1);
    expect(state.checkBlocked('p1')).toBeNull();
    await runSearch(REQ(), deps);
    expect(state.failStreak('p1')).toBe(0);
    expect(a.calls).toBe(2);
  });
  it('adapter 返回后取消仍不接受结果、不调用下一家、不惩罚健康', async () => {
    const a = new Fake('p1', [[r('https://ok.com')]]);
    a.delayMs = 30;
    const b = new Fake('p2', [[]]);
    const { deps, state } = mkDeps([a, b]);
    const controller = new AbortController();
    const pending = runSearch(REQ(), deps, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(0);
    expect(state.checkBlocked('p1')).toBeNull();
    expect(state.used('p1', deps.providers[0]!.cfg)).toBe(1);
  });
  it('单源超时冷却；总预算超时不归因于 provider', async () => {
    for (const total_budget_ms of [30, 1000]) {
      const { deps, state } = mkDeps([new Fake('p1', [])], mkConfig({ timeout_ms: 60, total_budget_ms }));
      deps.providers[0]!.adapter.search = async (_req, _count, signal) => {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return [];
      };
      const result = await runSearch(REQ(), deps);
      expect(result.meta.fallback_chain[0]?.outcome).toBe(total_budget_ms === 30 ? 'skipped:budget_exhausted' : 'timeout');
      expect(state.checkBlocked('p1') === null).toBe(total_budget_ms === 30);
    }
  });
  it.each(['normal', 'no_cache', 'disabled_cache', 'forced'])('%s 均按需取数并遵守来源上限', async mode => {
    for (const maxCount of [4, 100]) {
      const { deps } = mkDeps([new Fake('p1', [[]], maxCount)]);
      const search = vi.fn(async () => []);
      deps.providers[0]!.adapter.search = search;
      if (mode === 'disabled_cache') deps.config.cache.enabled = false;
      const request = REQ({ useCache: mode !== 'no_cache', provider: mode === 'forced' ? 'p1' : undefined });
      await runSearch(request, deps);
      expect(search).toHaveBeenCalledWith(request, maxCount === 4 ? 4 : 8, expect.any(AbortSignal));
    }
  });
});
