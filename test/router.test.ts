import { describe, expect, it, vi } from 'vitest';
import { orderForRequest, runSearch, winnerNotes, type ProviderEntry } from '../src/router.js';
import { normalizeUrl } from '../src/url.js';
import { GatewayState } from '../src/state.js';
import { parseConfig, type AppConfig } from '../src/config.js';
import { ProviderError, type DomainFilterCap, type ProviderAdapter, type RawResult, type SearchRequest } from '../src/types.js';
import { cfg } from './helpers.js';

/** 脚本化 FakeProvider：按序返回结果或抛错 */
class Fake implements ProviderAdapter {
  name: string;
  maxCount: number;
  includeDomains: DomainFilterCap;
  calls = 0;
  credentials: (string | undefined)[] = [];
  script: (RawResult[] | Error)[];
  delayMs = 0;
  note?: (req: SearchRequest) => string | undefined;
  constructor(name: string, script: (RawResult[] | Error)[], maxCount = 50, includeDomains: DomainFilterCap = 'native') {
    this.name = name;
    this.script = script;
    this.maxCount = maxCount;
    this.includeDomains = includeDomains;
  }
  async search(_req: SearchRequest, _fetchCount: number, _signal: AbortSignal, credential?: string): Promise<RawResult[]> {
    this.calls++;
    this.credentials.push(credential);
    if (this.delayMs) await new Promise(r => setTimeout(r, this.delayMs));
    const step = this.script.shift();
    if (step instanceof Error) throw step;
    return step ?? [];
  }
}

const DEFAULTS = { cooldown_default_s: 60, cooldown_max_s: 3600 };

function mkConfig(over: Record<string, unknown> = {}): AppConfig {
  return parseConfig({ defaults: { timeout_ms: 5000, total_budget_ms: 5000, ...over } }, {});
}

function mkDeps(adapters: Fake[], config = mkConfig()) {
  const state = new GatewayState();
  const providers: ProviderEntry[] = adapters.map(a => ({ cfg: cfg(a.name), adapter: a }));
  return { deps: { providers, state, config }, state };
}

const REQ = (over: Partial<SearchRequest> = {}): SearchRequest => ({ query: 'q', maxResults: 8, useCache: false, ...over });
const err = (type: ConstructorParameters<typeof ProviderError>[1], opts: ConstructorParameters<typeof ProviderError>[3] = {}) =>
  new ProviderError('x', type, 'fake', opts);
const r = (url: string, content?: string): RawResult => ({ title: 't', url, snippet: 's', content });

describe('Router：顺序兜底与错误处置', () => {
  it('首选 429 → 次选胜出；屏蔽期内该源被 skipped', async () => {
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

  it('配额信号 → 摘到上游给的恢复时间', async () => {
    const a = new Fake('p1', [err('quota_exhausted', { resetAtMs: Date.now() + 3_600_000 })]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.checkBlocked('p1')?.reason).toBe('quota_exhausted');
  });

  it('401 → 摘除到重启，后续跳过原因是 until_restart', async () => {
    const a = new Fake('p1', [err('auth_failure')]);
    const b = new Fake('p2', [[r('https://ok.com')], [r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.checkBlocked('p1', Date.now() + 365 * 86400_000)?.reason).toBe('auth_failure');
    const second = await runSearch(REQ(), deps);
    expect(second.meta.fallback_chain[0]).toMatchObject({ provider: 'p1', outcome: 'skipped:auth_failure', detail: 'until_restart' });
    expect(a.calls).toBe(1);
  });

  it('空结果 → 直接切换；不惩罚不屏蔽', async () => {
    const a = new Fake('p1', [[]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    const out = await runSearch(REQ(), deps);
    expect(out.meta.fallback_chain[0]?.outcome).toBe('no_results');
    expect(state.checkBlocked('p1')).toBeNull();
    expect(state.failStreak('p1')).toBe(0);
    expect(out.meta.provider_used).toBe('p2');
  });

  it('timeout → 直接切换，同源恰好 1 次请求、无重试', async () => {
    const a = new Fake('p1', [err('timeout'), [r('https://never.com')]]); // 若发生重试会吃到第二个脚本
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps } = mkDeps([a, b]);
    const out = await runSearch(REQ(), deps);
    expect(a.calls).toBe(1);
    expect(out.meta.provider_used).toBe('p2');
    expect(out.meta.fallback_chain[0]?.outcome).toBe('timeout');
  });

  it('全部故障 → 结构化空结果，不抛错', async () => {
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
    const { deps } = mkDeps([new Fake('p1', [[]]), new Fake('p2', [[]])]);
    const out = await runSearch(REQ(), deps);
    expect(out.results).toEqual([]);
    expect(out.meta.fallback_chain.every(s => s.outcome === 'no_results')).toBe(true);
  });

  it('总预算耗尽：请求过的源记 budget_exhausted，没轮到的源不请求', async () => {
    const a = new Fake('p1', [[r('https://slow.com')]]); a.delayMs = 120;
    const b = new Fake('p2', [[r('https://never.com')]]);
    const c = new Fake('p3', [[r('https://never.com')]]);
    const { deps } = mkDeps([a, b, c], mkConfig({ total_budget_ms: 80 }));
    const out = await runSearch(REQ(), deps);
    expect(out.meta.provider_used).toBeNull(); // 超过总预算的结果不再接受
    expect(out.meta.fallback_chain).toEqual([expect.objectContaining({ provider: 'p1', outcome: 'budget_exhausted' })]);
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

  it('按需取数，成功源计数 +1；凭据原样传给 adapter', async () => {
    const a = new Fake('p1', [[]], 10); // 该源最多 10 条
    const b = new Fake('p2', [[r('https://ok.com')]], 50);
    const { deps, state } = mkDeps([a, b]);
    deps.providers[1]!.credential = 'key-2';
    const seen: number[] = [];
    for (const p of deps.providers) {
      const orig = p.adapter.search.bind(p.adapter);
      p.adapter = { ...p.adapter, includeDomains: 'native', search: async (req, fc, sig, cred) => { seen.push(fc); return orig(req, fc, sig, cred); } };
    }
    await runSearch(REQ(), deps);
    expect(seen).toEqual([8, 8]);
    expect(state.used('p2', deps.providers[1]!.cfg)).toBe(1);
    expect(b.credentials).toEqual(['key-2']);
    expect(a.credentials).toEqual([undefined]);
  });

  it('同源去重：utm 变体 URL 保留信息更全的一条', async () => {
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
});

describe('include_domains 按能力路由，降级说明只来自给出结果的那一家', () => {
  it('能执行过滤的源先试：none 的源排在默认链前面也不会先被请求', async () => {
    const none = new Fake('bocha', [[r('https://unfiltered.com')]], 50, 'none');
    const native = new Fake('tavily', [[r('https://docs.rs/a')]], 50, 'native');
    const { deps } = mkDeps([none, native]);
    const out = await runSearch(REQ({ includeDomains: ['docs.rs'] }), deps);
    expect(out.meta.provider_used).toBe('tavily');
    expect(none.calls).toBe(0);
    expect(out.meta.note).toBeUndefined();
  });

  it('能过滤的源都失败后才落到不能过滤的源，说明只描述它', async () => {
    const none = new Fake('bocha', [[r('https://unfiltered.com')]], 50, 'none');
    const native = new Fake('tavily', [err('server_error')], 50, 'native');
    const { deps } = mkDeps([none, native]);
    const out = await runSearch(REQ({ includeDomains: ['docs.rs'] }), deps);
    expect(out.meta.fallback_chain.map(s => `${s.provider}:${s.outcome}`)).toEqual(['tavily:server_error']);
    expect(out.meta.provider_used).toBe('bocha');
    expect(out.meta.note).toBe('bocha: include_domains is not supported; the filter was ignored');
  });

  it('single 只在单域名时算能执行；多域名排到 native 之后', () => {
    const single = { cfg: cfg('brave'), adapter: new Fake('brave', [], 20, 'single') };
    const native = { cfg: cfg('exa'), adapter: new Fake('exa', [], 20, 'native') };
    const none = { cfg: cfg('bocha'), adapter: new Fake('bocha', [], 20, 'none') };
    const names = (domains?: string[]) => orderForRequest([none, single, native], REQ({ includeDomains: domains })).map(p => p.cfg.name);
    expect(names()).toEqual(['bocha', 'brave', 'exa']);
    expect(names(['a.com'])).toEqual(['brave', 'exa', 'bocha']);
    expect(names(['a.com', 'b.com'])).toEqual(['exa', 'bocha', 'brave']);
    expect(winnerNotes(single.adapter, REQ({ includeDomains: ['a.com', 'b.com'] }))).toEqual([
      'brave: include_domains supports a single domain only; the filter was ignored',
    ]);
  });

  it('adapter 自己的降级说明也只在它胜出时写入', async () => {
    const a = new Fake('p1', [err('server_error')]);
    a.note = () => 'p1: query truncated';
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps } = mkDeps([a, b]);
    expect((await runSearch(REQ(), deps)).meta.note).toBeUndefined();
    const c = new Fake('p3', [[r('https://ok.com')]]);
    c.note = () => 'p3: query truncated';
    expect((await runSearch(REQ(), mkDeps([c]).deps)).meta.note).toBe('p3: query truncated');
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

describe('配额软闸门与请求计数', () => {
  it('used ≥ limit → skipped:quota_local 且不发请求、不屏蔽', async () => {
    const a = new Fake('p1', [[r('https://never.com')]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const state = new GatewayState();
    const limited = cfg('p1', { quota: { type: 'monthly', limit: 2, reset_day: 1 } });
    state.tryStart('p1', limited);
    state.tryStart('p1', limited);
    const providers: ProviderEntry[] = [{ cfg: limited, adapter: a }, { cfg: cfg('p2'), adapter: b }];

    const out = await runSearch(REQ(), { providers, state, config: mkConfig() });
    expect(a.calls).toBe(0);
    expect(out.meta.fallback_chain[0]).toMatchObject({ provider: 'p1', outcome: 'skipped:quota_local', detail: '2/2' });
    expect(out.meta.provider_used).toBe('p2');
    expect(state.checkBlocked('p1')).toBeNull(); // 软闸门不进健康状态
  });

  it('unbounded / 未设 limit 的源不触发闸门', async () => {
    const a = new Fake('p1', [[r('https://ok.com')]]);
    const state = new GatewayState();
    const noLimit = cfg('p1', { quota: { type: 'one_time' } });
    for (let i = 0; i < 10; i++) state.tryStart('p1', noLimit);
    const out = await runSearch(REQ(), { providers: [{ cfg: noLimit, adapter: a }], state, config: mkConfig() });
    expect(a.calls).toBe(1);
    expect(out.meta.provider_used).toBe('p1');
  });

  it('空结果（no_results 路径）也计数', async () => {
    const a = new Fake('p1', [[]]);
    const b = new Fake('p2', [[r('https://ok.com')]]);
    const { deps, state } = mkDeps([a, b]);
    await runSearch(REQ(), deps);
    expect(state.used('p1', deps.providers[0]!.cfg)).toBe(1);
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
      const limited = deps.providers[0]!.cfg;
      limited.quota = { type: 'monthly', limit: 1, reset_day: 1 };
      await runSearch(REQ(), deps);

      // 新窗口已到，但上游尚未允许恢复。
      clock.mockReturnValue(new Date(2026, 9, 1, 0, 0, 0).getTime());
      const blocked = await runSearch(REQ(), deps);
      expect(blocked.meta.fallback_chain[0]?.outcome).toBe('skipped:quota_exhausted');
      expect(state.used('p1', limited)).toBe(0);
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

  it('单源超时冷却；总预算超时记 budget_exhausted 且不归因于 provider', async () => {
    for (const total_budget_ms of [30, 1000]) {
      const { deps, state } = mkDeps([new Fake('p1', [])], mkConfig({ timeout_ms: 60, total_budget_ms }));
      deps.providers[0]!.adapter.search = async (_req, _count, signal) => {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return [];
      };
      const result = await runSearch(REQ(), deps);
      expect(result.meta.fallback_chain[0]?.outcome).toBe(total_budget_ms === 30 ? 'budget_exhausted' : 'timeout');
      expect(state.checkBlocked('p1') === null).toBe(total_budget_ms === 30);
    }
  });

  it.each(['normal', 'no_cache', 'forced'])('%s 均按需取数并遵守来源上限', async mode => {
    for (const maxCount of [4, 100]) {
      const { deps } = mkDeps([new Fake('p1', [[]], maxCount)]);
      const search = vi.fn(async () => []);
      deps.providers[0]!.adapter.search = search;
      const request = REQ({ useCache: mode !== 'no_cache', provider: mode === 'forced' ? 'p1' : undefined });
      await runSearch(request, deps);
      expect(search).toHaveBeenCalledWith(request, maxCount === 4 ? 4 : 8, expect.any(AbortSignal), undefined);
    }
  });
});
