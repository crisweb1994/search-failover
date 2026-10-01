import { describe, expect, it } from 'vitest';
import { cacheKey, normalizeQuery, ResultCache } from '../../src/cache.js';

describe('normalizeQuery / cacheKey', () => {
  it('大小写与空白折叠视为等价', () => {
    expect(normalizeQuery('  Rust   Tokio ')).toBe('rust tokio');
    expect(cacheKey(normalizeQuery('Rust Tokio'), undefined, undefined))
      .toBe(cacheKey(normalizeQuery('rust   tokio'), undefined, undefined));
  });

  it('freshness 与 include_domains 参与 key', () => {
    const base = cacheKey('q', undefined, undefined);
    expect(cacheKey('q', 'day', undefined)).not.toBe(base);
    expect(cacheKey('q', undefined, ['a.com'])).not.toBe(base);
    // 域名顺序无关
    expect(cacheKey('q', undefined, ['a.com', 'b.com'])).toBe(cacheKey('q', undefined, ['b.com', 'a.com']));
  });
});

describe('ResultCache（D9 最简 TTL Map）', () => {
  const mk = () => new ResultCache({ ttl_s: 3600, ttl_fresh_s: 900, max_entries: 2 });
  const r = (url: string) => ({ title: 't', url, provider: 'p' as const });

  it('命中 / 过期 / 计数', () => {
    const c = mk();
    c.put('k', [r('https://a.com')], false, 1000);
    expect(c.get('k', 2000)).toHaveLength(1);
    expect(c.hits).toBe(1);

    const fresh = mk();
    fresh.put('k', [r('https://a.com')], true, 1000); // fresh → 900s TTL
    expect(fresh.get('k', 1000 + 899_000)).toHaveLength(1);
    expect(fresh.get('k', 1000 + 901_000)).toBeUndefined();
    expect(fresh.misses).toBe(1);
  });

  it('空结果不写入', () => {
    const c = mk();
    c.put('k', [], false);
    expect(c.size).toBe(0);
  });

  it('超容量逐出最旧（无访问时等价 FIFO）', () => {
    const c = mk();
    c.put('k1', [r('https://1.com')], false, 1000);
    c.put('k2', [r('https://2.com')], false, 1000);
    c.put('k3', [r('https://3.com')], false, 1000);
    expect(c.size).toBe(2);
    expect(c.get('k1', 2000)).toBeUndefined();
    expect(c.get('k2', 2000)).toHaveLength(1);
    expect(c.get('k3', 2000)).toHaveLength(1);
  });

  it('LRU：近期命中的条目不被逐出', () => {
    const c = mk();
    c.put('k1', [r('https://1.com')], false, 1000);
    c.put('k2', [r('https://2.com')], false, 1000);
    c.get('k1', 2000); // k1 提升热度
    c.put('k3', [r('https://3.com')], false, 1000);
    expect(c.get('k1', 2000)).toHaveLength(1); // 被逐出的是冷的 k2
    expect(c.get('k2', 2000)).toBeUndefined();
    expect(c.get('k3', 2000)).toHaveLength(1);
  });

  it('惰性清扫：第 16 次 put 时清掉过期条目，释放名额', () => {
    const c = new ResultCache({ ttl_s: 100, ttl_fresh_s: 50, max_entries: 100 });
    for (let i = 0; i < 15; i++) c.put(`old${i}`, [r(`https://old${i}.com`)], false, 1000);
    expect(c.size).toBe(15);
    c.put('new', [r('https://new.com')], false, 200_000); // 第 16 次 put 触发清扫，old* 已于 101s 过期
    expect(c.size).toBe(1);
    expect(c.get('new', 200_000)).toHaveLength(1);
  });
});
