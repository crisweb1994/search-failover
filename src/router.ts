import { log } from './logger.js';
import { normalizeUrl } from './url.js';
import { ProviderError } from './types.js';
import type {
  DomainFilterCap, FallbackStep, ProviderAdapter, RawResult, SearchMeta, SearchRequest, SearchResult,
} from './types.js';
import type { AppConfig, ProviderCfg } from './config.js';
import type { GatewayState } from './state.js';

export interface ProviderEntry {
  cfg: ProviderCfg;
  adapter: ProviderAdapter;
  /** 该源的 key 或实例地址；免凭据的源为 undefined */
  credential?: string;
}

export interface RouterDeps {
  /** 已按优先级排列、已过滤掉缺凭据的源 */
  providers: ProviderEntry[];
  state: GatewayState;
  config: Pick<AppConfig, 'defaults'>;
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

/** 该源能否完整执行这次请求的 include_domains */
export function honorsDomains(cap: DomainFilterCap, count: number): boolean {
  return cap === 'native' || (cap === 'single' && count === 1);
}

/** 带 include_domains 时，能执行过滤的源先试，不能的放到最后；各组内保持原有优先级 */
export function orderForRequest(providers: ProviderEntry[], req: SearchRequest): ProviderEntry[] {
  const count = req.includeDomains?.length ?? 0;
  if (!count) return providers;
  const able = providers.filter(p => honorsDomains(p.adapter.includeDomains, count));
  return [...able, ...providers.filter(p => !able.includes(p))];
}

/** 只描述最终给出结果的那一家做了哪些降级（冷请求与缓存命中共用） */
export function winnerNotes(adapter: ProviderAdapter, req: SearchRequest): string[] {
  const notes: string[] = [];
  const count = req.includeDomains?.length ?? 0;
  if (count && !honorsDomains(adapter.includeDomains, count)) {
    notes.push(adapter.includeDomains === 'single'
      ? `${adapter.name}: include_domains supports a single domain only; the filter was ignored`
      : `${adapter.name}: include_domains is not supported; the filter was ignored`);
  }
  const extra = adapter.note?.(req);
  if (extra) notes.push(extra);
  return notes;
}

function buildMeta(chain: FallbackStep[], providerUsed: string | null, elapsedMs: number, notes: string[]): SearchMeta {
  return {
    provider_used: providerUsed,
    fallback_chain: chain,
    cache_hit: false,
    elapsed_ms: elapsedMs,
    note: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

/**
 * 顺序兜底主循环：任何错误不在同一家重试，换下一家就是重试；
 * 统一按需取数，去重后由工具层截断到 maxResults 并写缓存。
 * outcome 里 `skipped:<原因>` 表示这次没有请求这一家；`budget_exhausted` 表示请求了，但总预算先用完。
 */
export async function runSearch(req: SearchRequest, deps: RouterDeps, requestSignal?: AbortSignal): Promise<{ results: SearchResult[]; meta: SearchMeta }> {
  const startedAt = Date.now();
  const chain: FallbackStep[] = [];
  const deadline = startedAt + deps.config.defaults.total_budget_ms;
  const record = (step: FallbackStep) => {
    chain.push(step);
    log.debug(`search ${step.provider}: ${step.outcome}${step.detail ? ` (${step.detail})` : ''} ${step.elapsedMs}ms`);
  };

  requestSignal?.throwIfAborted();
  for (const p of orderForRequest(deps.providers, req)) {
    requestSignal?.throwIfAborted();
    if (req.provider && p.cfg.name !== req.provider) continue;
    const name = p.cfg.name;
    const stepStart = Date.now();

    const blocked = deps.state.checkBlocked(name);
    if (blocked) {
      record({
        provider: name, outcome: `skipped:${blocked.reason}`,
        detail: Number.isFinite(blocked.remainS) ? `${blocked.remainS}s` : 'until_restart', elapsedMs: 0,
      });
      continue;
    }

    // 等待前先跳过满额来源；等待后仍由 tryStart 同步检查并计数。
    if (p.cfg.quota.type !== 'unbounded' && p.cfg.quota.limit !== undefined) {
      const used = deps.state.used(name, p.cfg);
      if (used >= p.cfg.quota.limit) {
        record({ provider: name, outcome: 'skipped:quota_local', detail: `${used}/${p.cfg.quota.limit}`, elapsedMs: 0 });
        continue;
      }
    }

    if (deadline - Date.now() <= 0) {
      record({ provider: name, outcome: 'skipped:budget_exhausted', elapsedMs: 0 });
      continue;
    }

    if (!(await deps.state.pace(name, p.cfg, deadline, requestSignal))) {
      record({ provider: name, outcome: 'skipped:local_rate', elapsedMs: Date.now() - stepStart });
      continue;
    }

    requestSignal?.throwIfAborted();
    const blockedAfterWait = deps.state.checkBlocked(name);
    if (blockedAfterWait) {
      record({ provider: name, outcome: `skipped:${blockedAfterWait.reason}`, elapsedMs: Date.now() - stepStart });
      continue;
    }
    const remainingMs = deadline - Date.now();
    const timeoutMs = Math.min(deps.config.defaults.timeout_ms, remainingMs);
    if (timeoutMs <= 0) {
      record({ provider: name, outcome: 'skipped:budget_exhausted', elapsedMs: Date.now() - stepStart });
      continue;
    }
    const fetchCount = Math.min(req.maxResults, p.adapter.maxCount);

    const budgetLimited = remainingMs <= deps.config.defaults.timeout_ms;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = requestSignal ? AbortSignal.any([requestSignal, timeoutSignal]) : timeoutSignal;
    if (!deps.state.tryStart(name, p.cfg)) {
      record({ provider: name, outcome: 'skipped:quota_local', elapsedMs: Date.now() - stepStart });
      continue;
    }
    try {
      const raws = await p.adapter.search(req, fetchCount, signal, p.credential);
      requestSignal?.throwIfAborted();
      if (Date.now() >= deadline) {
        record({ provider: name, outcome: 'budget_exhausted', elapsedMs: Date.now() - stepStart });
        break;
      }
      const elapsed = Date.now() - stepStart;
      deps.state.recordSuccess(name);
      if (raws.length === 0) {
        // no_results 不惩罚不屏蔽，直接切下一家
        record({ provider: name, outcome: 'no_results', elapsedMs: elapsed });
        continue;
      }
      log.debug(`search ${name}: ${raws.length} results ${elapsed}ms`);
      const results: SearchResult[] = dedupe(raws).map(r => ({ ...r, provider: name }));
      return { results, meta: buildMeta(chain, name, Date.now() - startedAt, winnerNotes(p.adapter, req)) };
    } catch (e) {
      requestSignal?.throwIfAborted();
      if ((budgetLimited && timeoutSignal.aborted) || Date.now() >= deadline) {
        record({ provider: name, outcome: 'budget_exhausted', elapsedMs: Date.now() - stepStart });
        break;
      }
      const err: ProviderError = e instanceof ProviderError
        ? e
        : new ProviderError(name, timeoutSignal.aborted ? 'timeout' : 'network', timeoutSignal.aborted ? 'aborted' : String(e));
      if (err.type === 'no_results') deps.state.recordSuccess(name);
      else deps.state.block(name, err, p.cfg, deps.config.defaults);
      record({ provider: name, outcome: err.type, detail: err.detail, elapsedMs: Date.now() - stepStart });
      continue;
    }
  }

  requestSignal?.throwIfAborted();
  return { results: [], meta: buildMeta(chain, null, Date.now() - startedAt, []) };
}
