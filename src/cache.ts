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

/** 最简 TTL Map（D9）：两档 TTL + 条数上限 FIFO 逐出，无负缓存 / single-flight / LRU */
export class ResultCache {
  private store = new Map<string, { results: SearchResult[]; expiresAtMs: number }>();
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
    this.hits++;
    return entry.results;
  }

  put(key: string, results: SearchResult[], fresh: boolean, now = Date.now()): void {
    if (results.length === 0) return;
    const ttlMs = (fresh ? this.cfg.ttl_fresh_s : this.cfg.ttl_s) * 1000;
    this.store.set(key, { results, expiresAtMs: now + ttlMs });
    if (this.store.size > this.cfg.max_entries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  get size(): number {
    return this.store.size;
  }
}
