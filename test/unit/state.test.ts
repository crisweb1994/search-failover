import { describe, expect, it } from 'vitest';
import { GatewayState, nextResetMs, paceWaitMs } from '../../src/state.js';
import { providerSchema, defaultProviders } from '../../src/config.js';
import { ProviderError } from '../../src/types.js';

const DEFAULTS = { cooldown_default_s: 60, cooldown_max_s: 3600 };
const NOW = new Date('2026-09-20T10:00:00').getTime();

const p = (over: Record<string, unknown> = {}) =>
  providerSchema.parse({ name: 'test', quota: { type: 'unbounded' }, ...over });

function err(type: ConstructorParameters<typeof ProviderError>[1], opts: ConstructorParameters<typeof ProviderError>[3] = {}) {
  return new ProviderError('test', type, 'unit', opts);
}

describe('GatewayState 屏蔽（D8）', () => {
  it('rate_limited：用 retryAfterMs，且被封顶', () => {
    const s = new GatewayState();
    s.block('test', err('rate_limited', { retryAfterMs: 60_000 }), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 1000)?.reason).toBe('rate_limited');
    expect(s.checkBlocked('test', NOW + 59_000)?.remainS).toBeLessThanOrEqual(60);
    expect(s.checkBlocked('test', NOW + 61_000)).toBeNull();

    const capped = new GatewayState();
    capped.block('test', err('rate_limited', { retryAfterMs: 10 * 3600_000 }), p({ cooldown_max_s: 3600 }), DEFAULTS, NOW);
    expect(capped.checkBlocked('test', NOW + 3600_000)).toBeNull(); // 上限 1h，10h 被截断
  });

  it('rate_limited 缺省 60s', () => {
    const s = new GatewayState();
    s.block('test', err('rate_limited'), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 30_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 61_000)).toBeNull();
  });

  it('timeout/network/server_error 阶梯翻倍', () => {
    const s = new GatewayState();
    s.block('test', err('timeout'), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 29_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 31_000)).toBeNull();

    s.block('test', err('timeout'), p(), DEFAULTS, NOW); // streak=1 → 60s
    expect(s.checkBlocked('test', NOW + 31_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 61_000)).toBeNull();

    s.block('test', err('timeout'), p(), DEFAULTS, NOW); // streak=2 → 120s
    expect(s.checkBlocked('test', NOW + 61_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 121_000)).toBeNull();
  });

  it('阶梯封顶到该源 cooldown_max_s', () => {
    const s = new GatewayState();
    const cfg = p({ cooldown_max_s: 120 });
    for (let i = 0; i < 6; i++) s.block('test', err('server_error'), cfg, DEFAULTS, NOW);
    // 60s×2^5 = 1920s，但封顶 120s
    expect(s.checkBlocked('test', NOW + 119_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 121_000)).toBeNull();
  });

  it('soft（未识别 4xx）不增失败阶梯', () => {
    const s = new GatewayState();
    s.block('test', err('server_error', { soft: true }), p(), DEFAULTS, NOW);
    expect(s.failStreak('test')).toBe(0);
    // 第二次仍是最初时长 60s 而非翻倍
    s.block('test', err('server_error', { soft: true }), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 61_000)).toBeNull();
  });

  it('quota_exhausted：直接用 resetAtMs，不走阶梯', () => {
    const s = new GatewayState();
    s.block('test', err('quota_exhausted', { resetAtMs: NOW + 123_456 }), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 1)?.reason).toBe('quota_exhausted');
    expect(s.checkBlocked('test', NOW + 124_000)).toBeNull();
  });

  it('quota_exhausted 无精确 resetAt 时按配置：monthly→重置点，one_time→quota_retry_s', () => {
    const monthly = p({ quota: { type: 'monthly', limit: 1000, reset_day: 15 } });
    const s = new GatewayState();
    s.block('a', err('quota_exhausted'), monthly, DEFAULTS, NOW);
    expect(s.checkBlocked('a', new Date('2026-10-14T23:00:00').getTime())).not.toBeNull();
    expect(s.checkBlocked('a', new Date('2026-10-15T00:00:01').getTime())).toBeNull();

    const oneTime = p({ quota: { type: 'one_time', quota_retry_s: 3600 } });
    s.block('b', err('quota_exhausted'), oneTime, DEFAULTS, NOW);
    expect(s.checkBlocked('b', NOW + 3000_000)).not.toBeNull();
    expect(s.checkBlocked('b', NOW + 3601_000)).toBeNull();
  });

  it('auth_failure → 长期摘除，recordSuccess 清零', () => {
    const s = new GatewayState();
    s.block('test', err('auth_failure'), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 365 * 86400_000)?.reason).toBe('auth_failure');
    s.recordSuccess('test');
    expect(s.checkBlocked('test', NOW)).toBeNull();
    expect(s.failStreak('test')).toBe(0);
  });
});

describe('nextReset / pace 辅助函数', () => {
  it('nextResetMs：过了本月 reset_day 则到下月', () => {
    const now = new Date('2026-09-20T10:00:00').getTime();
    expect(nextResetMs(now, 15)).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime()); // 9/15 已过 → 10/15
    expect(nextResetMs(now, 25)).toBe(new Date(2026, 8, 25, 0, 0, 0, 0).getTime()); // 9/25 未到
  });

  it('paceWaitMs：间隔不足补齐', () => {
    expect(paceWaitMs(undefined, 1050, NOW)).toBe(0);
    expect(paceWaitMs(NOW - 100, 1050, NOW)).toBe(950);
    expect(paceWaitMs(NOW - 2000, 1050, NOW)).toBe(0);
  });
});

describe('配额计数', () => {
  it('tick 累计、quota_warning 达 90% 置位', () => {
    const s = new GatewayState();
    const cfg = p({ quota: { type: 'monthly', limit: 10, reset_day: 1 } });
    for (let i = 0; i < 8; i++) s.tick('test', cfg);
    expect(s.used('test')).toBe(8);
    expect(s.quotaWarning('test', cfg)).toBe(false);
    s.tick('test', cfg);
    expect(s.quotaWarning('test', cfg)).toBe(true);
  });
});

describe('默认配置完整性', () => {
  it('五家默认 provider 名称与优先级', () => {
    const names = defaultProviders().map(x => `${x.priority}:${x.name}`);
    expect(names).toEqual(['1:bocha', '2:tavily', '3:brave', '4:exa', '5:duckduckgo']);
    expect(defaultProviders()[4]?.cooldown_max_s).toBe(21600);
  });
});
