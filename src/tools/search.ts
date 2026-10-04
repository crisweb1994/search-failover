import { z } from 'zod';
import type { AppConfig, ProviderCfg } from '../config.js';
import { cacheKey, normalizeQuery, ResultCache } from '../cache.js';
import { runSearch, type ProviderEntry } from '../router.js';
import type { GatewayState } from '../state.js';
import type { SearchMeta, SearchRequest, SearchResult } from '../types.js';
import { domainFilterDescribe, providerParamDescribe } from '../providers/describe.js';
import { log } from '../logger.js';

export const searchInput = {
  query: z.string().trim().min(1).describe('搜索词'),
  max_results: z.number().int().min(1).max(20).describe('返回条数上限，缺省 8').default(8),
  freshness: z.enum(['day', 'week', 'month', 'year']).describe('时间过滤：day/week/month/year').optional(),
  include_domains: z.array(z.string().trim().min(1).max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/, '请输入主机名，不接受 URL 或搜索操作符')).describe(domainFilterDescribe()).optional(),
  provider: z.string().trim().min(1).describe(providerParamDescribe()).optional(),
  use_cache: z.boolean().describe('是否允许命中缓存（同参数 1 小时内秒回且不耗配额）').default(true),
};

export interface ToolDeps {
  config: AppConfig;
  allProviders: ProviderCfg[];
  providers: ProviderEntry[];
  state: GatewayState;
  cache: ResultCache;
}

const QUERY_MAX_CHARS = 400;

export function makeSearchHandler(deps: ToolDeps) {
  return async (args: z.infer<z.ZodObject<typeof searchInput>>, extra?: { signal: AbortSignal }) => {
    const startedAt = Date.now();
    const signal = extra?.signal;
    try {
      signal?.throwIfAborted();
      const notes: string[] = [];

      let query = args.query.trim();
      if (query.length > QUERY_MAX_CHARS) {
        query = query.slice(0, QUERY_MAX_CHARS);
        notes.push(`query 超过 ${QUERY_MAX_CHARS} 字符已截断`);
      }

      const req: SearchRequest = {
        query,
        maxResults: args.max_results,
        freshness: args.freshness,
        includeDomains: args.include_domains,
        provider: args.provider,
        useCache: args.use_cache,
      };
      if (req.provider && !deps.providers.some(p => p.cfg.name === req.provider)) {
        notes.push(`provider ${req.provider} 未配置或不可用`);
      }

      const key = cacheKey(normalizeQuery(query), req.freshness, req.includeDomains);
      const cacheUsable = deps.config.cache.enabled && req.useCache && !req.provider;

      const cached = cacheUsable ? deps.cache.get(key) : undefined;

      let results: SearchResult[];
      let meta: SearchMeta;
      if (cached) {
        results = cached;
        const note = deps.providers.find(p => p.cfg.name === cached[0]?.provider)?.adapter.note?.(req);
        meta = {
          provider_used: cached[0]?.provider ?? null,
          fallback_chain: [],
          cache_hit: true,
          note,
          elapsed_ms: Date.now() - startedAt,
        };
      } else {
        const outcome = await runSearch(req, deps, signal);
        results = outcome.results;
        meta = outcome.meta;
        signal?.throwIfAborted();
        if (cacheUsable && results.length > 0) {
          // D12 配套：as_requested 源的短结果入缓存会毒化后续更大 max_results 的命中
          // （缓存 key 不含条数、命中只截断不补取），仅取满时才写
          const winner = meta.provider_used
            ? deps.allProviders.find(p => p.name === meta.provider_used)
            : undefined;
          const cacheable = !winner || winner.fetch_policy !== 'as_requested'
            || results.length >= deps.config.cache.store_size;
          if (cacheable) deps.cache.put(key, results, req.freshness === 'day');
        }
      }

      if (notes.length > 0) {
        meta.note = meta.note ? `${meta.note}；${notes.join('；')}` : notes.join('；');
      }

      const payload = { results: results.slice(0, req.maxResults), meta };
      const isError = results.length === 0 && (meta.fallback_chain.length === 0
        || meta.fallback_chain.some(step => step.outcome !== 'no_results'));
      return { isError, content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (e) {
      signal?.throwIfAborted();
      // 工程红线：不向宿主抛裸异常，进程不崩
      log.error(`search 内部错误: ${String(e instanceof Error ? e.stack : e)}`);
      const payload = {
        results: [],
        meta: {
          provider_used: null,
          fallback_chain: [{ provider: 'gateway', outcome: 'internal_error', detail: String(e instanceof Error ? e.message : e), elapsedMs: 0 }],
          cache_hit: false,
          elapsed_ms: Date.now() - startedAt,
        },
      };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    }
  };
}
