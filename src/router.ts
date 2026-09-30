import { GatewayState } from './state.js';
import { ProviderError } from './types.js';
import type { RawResult, SearchMeta, SearchRequest, SearchResult, ProviderAdapter, FallbackStep } from './types.js';
import type { AppConfig, ProviderCfg } from './config.js';

export interface ProviderEntry {
  cfg: ProviderCfg;
  adapter: ProviderAdapter;
}

export interface RouterDeps {
  /** 已按 priority 排序、已过滤未配置 key 的源 */
  providers: ProviderEntry[];
  state: GatewayState;
  config: AppConfig;
}

/** URL 规范化（仅作 dedupe key，返回保留原 URL） */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'ref', 'ref_src', 'spm', 'from', 'vd_source',
]);

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    const kept = [...u.searchParams.entries()].filter(([k]) => !k.startsWith('utm_') && !TRACKING_PARAMS.has(k));
    u.search = '';
    for (const [k, v] of kept) u.searchParams.append(k, v);
    let s = u.toString();
    if (u.pathname === '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

/** 同源去重：同规范化 URL 保留信息更全（content/snippet 更长）的一条 */
export function dedupe(raws: RawResult[]): RawResult[] {
  const m = new Map<string, RawResult>();
  const richness = (r: RawResult): number => (r.content ?? r.snippet ?? '').length;
  for (const r of raws) {
    const key = normalizeUrl(r.url);
    const prev = m.get(key);
    if (!prev || richness(r) > richness(prev)) m.set(key, r);
  }
  return [...m.values()];
}

function buildMeta(chain: FallbackStep[], providerUsed: string | null, elapsedMs: number, notes: string[]): SearchMeta {
  const skipped = chain.filter(s => s.outcome.startsWith('skipped:'));
  const parts = [...notes];
  if (skipped.length > 0) {
    parts.push(`跳过: ${skipped.map(s => `${s.provider}(${s.outcome.slice(8)})`).join('、')}`);
  }
  return {
    provider_used: providerUsed,
    fallback_chain: chain,
    cache_hit: false,
    elapsed_ms: elapsedMs,
    note: parts.length > 0 ? parts.join('；') : undefined,
  };
}

/**
 * 顺序兜底主循环（§3）：任何错误不重试，failover 即重试（D6 v1.2）；
 * 返回完整结果集（不截断），由工具层截断到 maxResults 并写缓存。
 */
export async function runSearch(req: SearchRequest, deps: RouterDeps): Promise<{ results: SearchResult[]; meta: SearchMeta }> {
  const startedAt = Date.now();
  const chain: FallbackStep[] = [];
  const notes: string[] = [];
  const deadline = startedAt + deps.config.defaults.total_budget_ms;

  for (const p of deps.providers) {
    if (req.provider && p.cfg.name !== req.provider) continue;
    const stepStart = Date.now();

    const blocked = deps.state.checkBlocked(p.cfg.name);
    if (blocked) {
      chain.push({ provider: p.cfg.name, outcome: `skipped:${blocked.reason}`, detail: `${blocked.remainS}s`, elapsedMs: 0 });
      continue;
    }

    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) {
      chain.push({ provider: p.cfg.name, outcome: 'skipped:budget_exhausted', elapsedMs: 0 });
      continue;
    }

    const degradeNote = p.adapter.note?.(req);
    if (degradeNote) notes.push(degradeNote);

    if (!(await deps.state.pace(p.cfg.name, p.cfg, budgetLeft))) {
      chain.push({ provider: p.cfg.name, outcome: 'skipped:local_rate', elapsedMs: Date.now() - stepStart });
      continue;
    }

    const timeoutMs = Math.min(deps.config.defaults.timeout_ms, deadline - Date.now());
    if (timeoutMs <= 0) {
      chain.push({ provider: p.cfg.name, outcome: 'skipped:budget_exhausted', elapsedMs: Date.now() - stepStart });
      continue;
    }
    const fetchCount = Math.min(deps.config.cache.store_size, p.adapter.maxCount);

    try {
      const raws = await p.adapter.search(req, fetchCount, AbortSignal.timeout(timeoutMs));
      const elapsed = Date.now() - stepStart;
      if (raws.length === 0) {
        // D3：no_results 不惩罚不屏蔽，直接切下一家
        chain.push({ provider: p.cfg.name, outcome: 'no_results', elapsedMs: elapsed });
        continue;
      }
      deps.state.recordSuccess(p.cfg.name);
      deps.state.tick(p.cfg.name, p.cfg);
      const results: SearchResult[] = dedupe(raws).map(r => ({ ...r, provider: p.cfg.name }));
      return { results, meta: buildMeta(chain, p.cfg.name, Date.now() - startedAt, notes) };
    } catch (e) {
      const err: ProviderError = e instanceof ProviderError
        ? e
        : new ProviderError(p.cfg.name, 'network', String(e));
      deps.state.block(p.cfg.name, err, p.cfg, deps.config.defaults);
      chain.push({ provider: p.cfg.name, outcome: err.type, detail: err.detail, elapsedMs: Date.now() - stepStart });
      continue;
    }
  }

  return { results: [], meta: buildMeta(chain, null, Date.now() - startedAt, notes) };
}
