import { describe, expect, it } from 'vitest';
import { GatewayState, paceWaitMs } from '../../src/state.js';
import { parseConfig } from '../../src/config.js';
import { PROVIDERS } from '../../src/providers/registry.js';
import { ProviderError } from '../../src/types.js';
import { cfg } from '../helpers.js';

const DEFAULTS = { cooldown_default_s: 60, cooldown_max_s: 3600 };
const NOW = new Date('2026-09-20T10:00:00').getTime();

const p = (over: Parameters<typeof cfg>[1] = {}) => cfg('test', over);

function err(type: ConstructorParameters<typeof ProviderError>[1], opts: ConstructorParameters<typeof ProviderError>[3] = {}) {
  return new ProviderError('test', type, 'unit', opts);
}

describe('GatewayState 屏蔽', () => {
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
    const capped = p({ cooldown_max_s: 120 });
    for (let i = 0; i < 6; i++) s.block('test', err('server_error'), capped, DEFAULTS, NOW);
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
    s.block('test', err('quota_exhausted', { resetAtMs: NOW + 24 * 3600_000 }), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 1)?.reason).toBe('quota_exhausted');
    expect(s.checkBlocked('test', NOW + 23 * 3600_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 24 * 3600_000)).toBeNull();
    expect(s.failStreak('test')).toBe(0);
  });

  it.each(['monthly', 'one_time', 'unbounded'] as const)('quota_exhausted：%s 缺少恢复时间均等待 6h，不受普通冷却上限限制', type => {
    const s = new GatewayState();
    s.block('test', err('quota_exhausted'), p({ quota: { type, limit: 1000, reset_day: 15 } }), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 5 * 3600_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 6 * 3600_000)).toBeNull();
    expect(s.failStreak('test')).toBe(0);
  });

  it.each([NOW - 1, NOW, NaN, Infinity, -Infinity])('无效或过期的上游时间 %s 回退到配置间隔', resetAtMs => {
    const s = new GatewayState();
    s.block('test', err('quota_exhausted', { resetAtMs }), p({ quota_retry_s: 600 }), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 599_000)).not.toBeNull();
    expect(s.checkBlocked('test', NOW + 600_000)).toBeNull();
  });

  it('quota_retry_s=0 不施加健康冷却', () => {
    const s = new GatewayState();
    s.block('test', err('quota_exhausted'), p({ quota_retry_s: 0 }), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW)).toBeNull();
  });

  it('auth_failure → 长期摘除，recordSuccess 清零', () => {
    const s = new GatewayState();
    s.block('test', err('auth_failure'), p(), DEFAULTS, NOW);
    expect(s.checkBlocked('test', NOW + 365 * 86400_000)).toEqual({ reason: 'auth_failure', remainS: Infinity });
    s.recordSuccess('test');
    expect(s.checkBlocked('test', NOW)).toBeNull();
    expect(s.failStreak('test')).toBe(0);
  });
});

describe('pace 辅助函数', () => {
  it('paceWaitMs：间隔不足补齐', () => {
    expect(paceWaitMs(undefined, 1050, NOW)).toBe(0);
    expect(paceWaitMs(NOW - 100, 1050, NOW)).toBe(950);
    expect(paceWaitMs(NOW - 2000, 1050, NOW)).toBe(0);
  });
});

describe('配额计数', () => {
  it('tick 累计、quota_warning 达 90% 置位', () => {
    const s = new GatewayState();
    const monthly = p({ quota: { type: 'monthly', limit: 10, reset_day: 1 } });
    for (let i = 0; i < 8; i++) s.tryStart('test', monthly);
    expect(s.used('test', monthly)).toBe(8);
    expect(s.quotaWarning('test', monthly)).toBe(false);
    s.tryStart('test', monthly);
    expect(s.quotaWarning('test', monthly)).toBe(true);
  });

  it('tick 计数窗口：reset_day=31 clamp 后跨月不提前开新窗口', () => {
    const s = new GatewayState();
    const day31 = p({ quota: { type: 'monthly', limit: 100, reset_day: 31 } });
    // 无 clamp 时 9/31 滚成 10/1，10/1 请求即开新 period；clamp 后窗口起点 9/30，10 月内同一窗口
    s.tryStart('test', day31, new Date('2026-10-01T10:00:00').getTime());
    s.tryStart('test', day31, new Date('2026-10-15T10:00:00').getTime());
    expect(s.used('test', day31, new Date('2026-10-15T10:00:00').getTime())).toBe(2);
    // 重置点 10/31 00:00 已过 → 新窗口重新计数
    s.tryStart('test', day31, new Date('2026-10-31T10:00:00').getTime());
    expect(s.used('test', day31, new Date('2026-10-31T10:00:00').getTime())).toBe(1);
    // 11 月初仍属 [10/31, 11/30) 窗口，继续累计
    s.tryStart('test', day31, new Date('2026-11-02T10:00:00').getTime());
    expect(s.used('test', day31, new Date('2026-11-02T10:00:00').getTime())).toBe(2);
  });
});

describe('默认配置（注册表派生）', () => {
  const byName = Object.fromEntries(parseConfig({}, {}).providers.map(x => [x.name, x]));

  it('默认链 = defaultEnabled 的来源，按注册表顺序', () => {
    expect(parseConfig({}, {}).providers.map(x => x.name)).toEqual(['bocha', 'tavily', 'brave', 'exa', 'searxng', 'duckduckgo']);
    expect(PROVIDERS.filter(d => !d.defaultEnabled).map(d => d.adapter.name)).toEqual(['zhipu', 'qianfan', 'serper']);
  });

  it('默认值随注册表带入：限速、冷却上限、本地预算', () => {
    expect(byName['duckduckgo']).toMatchObject({ cooldown_max_s: 21600, min_interval_ms: 2000, quota: { type: 'unbounded' } });
    expect(byName['brave']).toMatchObject({ local_qps: 1, quota: { type: 'monthly', limit: 1000, reset_day: 15 }, quota_retry_s: 21600 });
  });
});

describe('请求预算周期与并发等待', () => {
  it('monthly 满额后读取即跨月恢复；one_time 和 unbounded 跨月累计', () => {
    const before = new Date('2026-09-30T23:59:59').getTime();
    const after = new Date('2026-10-01T00:00:00').getTime();
    for (const type of ['monthly', 'one_time', 'unbounded'] as const) {
      const s = new GatewayState();
      const limited = p({ quota: { type, limit: 1, reset_day: 1 } });
      expect(s.tryStart('test', limited, before)).toBe(true);
      expect(s.used('test', limited, after)).toBe(type === 'monthly' ? 0 : 1);
      expect(s.tryStart('test', limited, after)).toBe(type !== 'one_time');
    }
  });
  it('三个并发等待按 100ms 间隔放行', async () => {
    const s = new GatewayState();
    const paced = p({ min_interval_ms: 100 });
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(async () => {
      expect(await s.pace('test', paced, Date.now() + 2000)).toBe(true);
      starts.push(Date.now());
    }));
    // sleep 按单调时钟计时、断言用 Date.now() 墙上时钟读数，允许毫秒级偏斜；
    // 原竞态（并发同时放行）的间隔≈0，留 5ms 容差仍能稳定拦截
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(95);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(95);
  });
  it('取消等待不预约未来时隙；期限不足不放行', async () => {
    const s = new GatewayState();
    const paced = p({ min_interval_ms: 100 });
    await s.pace('test', paced, Date.now() + 1000);
    const controller = new AbortController();
    const pending = s.pace('test', paced, Date.now() + 1000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(await s.pace('test', paced, Date.now() + 10)).toBe(false);
  });
});
