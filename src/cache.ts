import { createHash } from 'node:crypto';
import type { Freshness, SearchResult } from './types.js';

export interface CacheCfg {
  enabled: boolean;
  store_size: number;
  ttl_s: number;
  ttl_fresh_s: number;
  max_entries: number;
}

/** 仅用于缓存 key；上游收到的永远是用户原始查询 */
export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function cacheKey(
  normalized: string,
  freshness: Freshness | undefined,
  includeDomains: string[] | undefined,
): string {
  const domains = (includeDomains ?? []).slice().sort().join(',');
  return createHash('sha1').update(`${normalized}\0${freshness ?? ''}\0${domains}`).digest('hex');
}

/** 最简 TTL Map（D9）：两档 TTL + 条数上限 LRU 逐出 + 每 16 次 put 惰性清扫过期条目，无负缓存 / single-flight */
export class ResultCache {
  private store = new Map<string, { results: SearchResult[]; expiresAtMs: number }>();
  private putsSinceSweep = 0;
  hits = 0;
  misses = 0;

  constructor(private cfg: Pick<CacheCfg, 'ttl_s' | 'ttl_fresh_s' | 'max_entries'>) {}

  get(key: string, now = Date.now()): SearchResult[] | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (now >= entry.expiresAtMs) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU：命中即移到 Map 尾部（最不易被逐出）
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.results;
  }

  put(key: string, results: SearchResult[], fresh: boolean, now = Date.now()): void {
    if (results.length === 0) return;
    const ttlMs = (fresh ? this.cfg.ttl_fresh_s : this.cfg.ttl_s) * 1000;
    this.store.delete(key); // 重新写入也提升热度
    this.store.set(key, { results, expiresAtMs: now + ttlMs });
    // 惰性过期清扫：过期条目不占内存风险（max_entries 封顶），但占名额——定期释放
    if (++this.putsSinceSweep >= 16) {
      this.putsSinceSweep = 0;
      for (const [k, e] of this.store) {
        if (now >= e.expiresAtMs) this.store.delete(k);
      }
    }
    while (this.store.size > this.cfg.max_entries) {
      const coldest = this.store.keys().next().value;
      if (coldest === undefined) break;
      this.store.delete(coldest);
    }
  }

  get size(): number {
    return this.store.size;
  }
}
