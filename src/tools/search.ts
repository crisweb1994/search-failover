import { z } from 'zod';
import { cacheKey, normalizeQuery } from '../cache.js';
import { runSearch, winnerNotes } from '../router.js';
import type { Runtime } from '../runtime.js';
import type { Freshness, SearchMeta, SearchRequest, SearchResult } from '../types.js';
import { normalizeDomain } from '../url.js';
import { includeDomainsDescription, providerParamDescription } from '../providers/describe.js';
import { log } from '../logger.js';

const QUERY_MAX_CHARS = 400;
const MAX_RESULTS = 20;

/** 模型常传字符串数字或超过上限的值：转成整数并截到 1..20，而不是让整次调用报参数错误 */
function clampCount(v: unknown): unknown {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_RESULTS, Math.max(1, Math.round(n))) : v;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const toBool = (v: unknown) => (v === 'true' ? true : v === 'false' ? false : v);
/** 有些客户端把没填的可选参数传成 null：一律当作没传 */
const loose = (fn: (v: unknown) => unknown = v => v) => (v: unknown) => (v === null ? undefined : fn(v));

/** `https://docs.rs/x`、`site:docs.rs` 之类的写法归一成主机名，确实认不出来才报错 */
const domainSchema = z.string().transform((raw, ctx) => {
  const host = normalizeDomain(raw);
  if (host) return host;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${raw}" is not a hostname (expected something like docs.python.org)` });
  return z.NEVER;
});

export interface SearchArgs {
  query: string;
  max_results: number;
  freshness?: Freshness;
  include_domains?: string[];
  use_cache: boolean;
  provider?: string;
}

/** 参数描述随运行链生成；provider 是调试参数，只在 SEARCH_FAILOVER_DEBUG=1 时暴露给模型 */
export function buildSearchInput(rt: Runtime) {
  const shape = {
    query: z.string().trim().min(1).describe('Search query; keep it short and specific.'),
    max_results: z.preprocess(loose(clampCount), z.number().int().min(1).max(MAX_RESULTS).default(8))
      .describe('Maximum number of results (1-20, default 8).'),
    freshness: z.preprocess(loose(lower), z.enum(['day', 'week', 'month', 'year']).optional())
      .describe('Only return results published within the past day, week, month or year.'),
    include_domains: z.preprocess(loose(v => (typeof v === 'string' ? [v] : v)), z.array(domainSchema).max(20).optional())
      .describe(includeDomainsDescription(rt)),
    use_cache: z.preprocess(loose(toBool), z.boolean().default(true))
      .describe('Set to false to bypass the result cache (e.g. breaking news).'),
  };
  if (!rt.debug) return shape;
  return { ...shape, provider: z.preprocess(loose(), z.string().trim().min(1).optional()).describe(providerParamDescription(rt)) };
}

/**
 * 输出总量控制：content/snippet 合计超过预算时，用注水法分配——短的先拿走自己需要的，
 * 剩下的平分给长的，再按各自的份额截断。宿主对工具输出普遍有上限（如 Claude Code 默认 25k token）。
 */
export function fitOutputBudget(results: SearchResult[], maxChars: number): { results: SearchResult[]; trimmed: boolean } {
  const lengths = results.map(r => (r.content ?? r.snippet ?? '').length);
  if (lengths.reduce((a, b) => a + b, 0) <= maxChars) return { results, trimmed: false };
  const caps: number[] = [];
  let budget = maxChars;
  let left = results.length;
  for (const i of lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]!)) {
    caps[i] = Math.min(lengths[i]!, Math.floor(budget / left));
    budget -= caps[i]!;
    left -= 1;
  }
  return {
    trimmed: true,
    results: results.map((r, i) => {
      if (lengths[i]! <= caps[i]!) return r;
      const field = r.content !== undefined ? 'content' : 'snippet';
      return { ...r, [field]: `${r[field]!.slice(0, Math.max(0, caps[i]! - 1))}…` };
    }),
  };
}

function failure(startedAt: number, outcome: string, detail: string) {
  const meta: SearchMeta = {
    provider_used: null,
    fallback_chain: [{ provider: 'gateway', outcome, detail, elapsedMs: 0 }],
    cache_hit: false,
    elapsed_ms: Date.now() - startedAt,
  };
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ results: [], meta }) }] };
}

export function makeSearchHandler(rt: Runtime) {
  return async (args: SearchArgs, extra?: { signal: AbortSignal }) => {
    const startedAt = Date.now();
    const signal = extra?.signal;
    try {
      signal?.throwIfAborted();
      if (rt.configError) return failure(startedAt, 'config_error', rt.configError);
      if (rt.providers.length === 0) {
        return failure(startedAt, 'no_provider', 'no search provider is configured; call web_search_status for details');
      }
      const notes: string[] = [];

      let query = args.query.trim();
      if (query.length > QUERY_MAX_CHARS) {
        query = query.slice(0, QUERY_MAX_CHARS);
        notes.push(`query truncated to ${QUERY_MAX_CHARS} characters`);
      }

      const req: SearchRequest = {
        query,
        maxResults: args.max_results,
        freshness: args.freshness,
        includeDomains: args.include_domains?.length ? [...new Set(args.include_domains)] : undefined,
        provider: rt.debug ? args.provider : undefined,
        useCache: args.use_cache,
      };
      if (req.provider && !rt.providers.some(p => p.cfg.name === req.provider)) {
        notes.push(`provider ${req.provider} is not configured`);
      }

      const key = cacheKey(normalizeQuery(query), req.maxResults, req.freshness, req.includeDomains);
      const cacheUsable = rt.config.cache.enabled && req.useCache && !req.provider;
      const cached = cacheUsable ? rt.cache.get(key) : undefined;

      let results: SearchResult[];
      let meta: SearchMeta;
      if (cached) {
        results = cached;
        const winner = rt.providers.find(p => p.cfg.name === cached[0]?.provider);
        const winnerNote = winner ? winnerNotes(winner.adapter, req) : [];
        meta = {
          provider_used: cached[0]?.provider ?? null,
          fallback_chain: [],
          cache_hit: true,
          elapsed_ms: Date.now() - startedAt,
          note: winnerNote.length ? winnerNote.join('; ') : undefined,
        };
      } else {
        const outcome = await runSearch(req, rt, signal);
        results = outcome.results.slice(0, req.maxResults);
        meta = outcome.meta;
        signal?.throwIfAborted();
        if (cacheUsable && results.length > 0) rt.cache.put(key, results, req.freshness === 'day');
      }

      const fitted = fitOutputBudget(results, rt.config.defaults.max_output_chars);
      if (fitted.trimmed) {
        notes.push(`content trimmed to fit ${rt.config.defaults.max_output_chars} characters; fetch the url for the full text`);
      }
      if (notes.length > 0) meta.note = meta.note ? `${meta.note}; ${notes.join('; ')}` : notes.join('; ');

      const isError = results.length === 0 && (meta.fallback_chain.length === 0
        || meta.fallback_chain.some(step => step.outcome !== 'no_results'));
      return { isError, content: [{ type: 'text' as const, text: JSON.stringify({ results: fitted.results, meta }) }] };
    } catch (e) {
      signal?.throwIfAborted();
      // 不向宿主抛裸异常，进程不崩
      log.error(`web_search internal error: ${String(e instanceof Error ? e.stack : e)}`);
      return failure(startedAt, 'internal_error', String(e instanceof Error ? e.message : e));
    }
  };
}
