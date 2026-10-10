import { describe, expect, it } from 'vitest';
import { defaultProviders, parseConfig } from '../../src/config.js';

describe('配置继承与边界', () => {
  it('省略名单用默认；空名单保留；opt-in 继承保护但不自动开启', () => {
    expect(parseConfig({}).providers).toEqual(defaultProviders());
    expect(parseConfig({ providers: [] }).providers).toEqual([]);
    const config = parseConfig({ providers: [
      { name: 'brave' }, { name: 'qianfan', enabled: true }, { name: 'serper' }, { name: 'duckduckgo' },
    ] });
    expect(config.providers[0]).toMatchObject({ local_qps: 1, quota: { limit: 1000 } });
    expect(config.providers[1]).toMatchObject({ enabled: true, local_qps: 1, quota: { limit: 1500 } });
    expect(config.providers[2]).toMatchObject({ enabled: false, quota: { limit: 2500 } });
    expect(config.providers[3]).toMatchObject({ min_interval_ms: 2000, cooldown_max_s: 21600 });
  });
  it('只合并同类型 quota；类型切换丢弃旧类型字段', () => {
    expect(parseConfig({ providers: [{ name: 'brave', quota: { limit: 0 } }] }).providers[0]?.quota)
      .toEqual({ type: 'monthly', limit: 0, reset_day: 15 });
    expect(parseConfig({ providers: [{ name: 'brave', quota: { type: 'unbounded' } }] }).providers[0]?.quota)
      .toEqual({ type: 'unbounded' });
  });
  it('旧恢复间隔提升到顶层，类型切换不丢失；显式顶层值含 0 优先', () => {
    const parse = (over: Record<string, unknown>) => parseConfig({ providers: [{ name: 'brave', ...over }] }).providers[0]!;
    expect(parse({}).quota_retry_s).toBe(21600);
    const migrated = parse({ quota: { type: 'unbounded', quota_retry_s: 600 } });
    expect(migrated.quota_retry_s).toBe(600);
    expect(migrated.quota).toEqual({ type: 'unbounded' });
    expect(parse({ quota_retry_s: 0, quota: { quota_retry_s: 600 } }).quota_retry_s).toBe(0);
    expect(parse({ quota_retry_s: 300, quota: { quota_retry_s: 600 } }).quota_retry_s).toBe(300);
  });
  it('合法的旧取数字段可启动，但不进入运行配置', () => {
    for (const fetch_policy of ['cache_fill', 'as_requested']) {
      const config = parseConfig({ providers: [{ name: 'exa', fetch_policy }], cache: { store_size: 2 } });
      expect(config.providers[0]).not.toHaveProperty('fetch_policy');
      expect(config.cache).not.toHaveProperty('store_size');
    }
  });
  it.each([
    null, [], { providers: null }, { providers: [{ name: 'unknown' }] },
    { providers: [{ name: 'brave' }, { name: 'brave' }] },
    ...[0, -1, 0.5, Infinity].map(timeout_ms => ({ defaults: { timeout_ms } })),
    { defaults: { cooldown_max_s: -1 } },
    { providers: [{ name: 'exa', fetch_policy: 'unknown' }] },
    ...[0, 21, 1.5, null, '2', Infinity].map(store_size => ({ cache: { store_size } })),
    ...[-1, Infinity, NaN, '600', null].flatMap(value => [
      { providers: [{ name: 'brave', quota_retry_s: value }] },
      { providers: [{ name: 'brave', quota_retry_s: 300, quota: { quota_retry_s: value } }] },
    ]),
    ...[{ local_qps: 0 }, { min_interval_ms: -1 }, { quota: { limit: -1 } }, { enabled: 'true' }]
      .map(over => ({ providers: [{ name: 'brave', ...over }] })),
  ])('拒绝不合法配置 %#', value => { expect(() => parseConfig(value)).toThrow(); });
});
