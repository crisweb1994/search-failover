#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { apiKeyFor, loadConfig } from './config.js';
import { ResultCache } from './cache.js';
import { GatewayState } from './state.js';
import type { ProviderAdapter } from './types.js';
import { bocha } from './providers/bocha.js';
import { tavily } from './providers/tavily.js';
import { brave } from './providers/brave.js';
import { exa } from './providers/exa.js';
import { duckduckgo } from './providers/ddg.js';
import { makeSearchHandler, searchInput } from './tools/search.js';
import { makeStatusHandler } from './tools/status.js';
import { log } from './logger.js';

const ADAPTERS: Record<string, ProviderAdapter> = { bocha, tavily, brave, exa, duckduckgo };

const SEARCH_DESCRIPTION = [
  '聚合网页搜索（博查/Tavily/Brave/Exa/DuckDuckGo 顺序容灾，任一来源限额、超时或空结果时自动切换下一家）。',
  '每条结果必有 title/url/snippet；content/publishedDate/score 为部分源提供的可选字段（可能缺失，缺失时请自行访问 url）。',
  'publishedDate 尽力而为、不保证精确；严格时间过滤请用 freshness 参数（服务端过滤）。',
  '仅搜特定域名用 include_domains（Tavily/Exa 原生支持，Brave 支持单域名，博查/DDG 忽略该参数并会在 note 中说明）。',
  '同参数 1 小时内命中缓存（use_cache=false 可关闭）；返回 results: [] 表示全部源均未搜到，可改写查询后重试。',
].join('');

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new GatewayState();
  const cache = new ResultCache(config.cache);

  const providers = config.providers
    .filter(p => p.enabled && ADAPTERS[p.name] && (p.name === 'duckduckgo' || apiKeyFor(p.name)))
    .sort((a, b) => a.priority - b.priority)
    .map(cfg => ({ cfg, adapter: ADAPTERS[cfg.name]! }));

  const deps = { config, allProviders: config.providers, providers, state, cache };

  const server = new McpServer({ name: 'search-failover', version: '0.1.0' });
  server.registerTool('search', { description: SEARCH_DESCRIPTION, inputSchema: searchInput }, makeSearchHandler(deps));
  server.registerTool(
    'status',
    { description: '网关状态仪表盘：各源屏蔽状态（blocked 原因与剩余时长）、配额用量与预警、缓存命中统计。无参数。' },
    makeStatusHandler(deps),
  );

  await server.connect(new StdioServerTransport());
  log.info(`search-failover 已启动，可用源: ${providers.map(p => p.cfg.name).join(' -> ') || '(无)'}`);
}

main().catch(err => {
  log.error(`启动失败: ${String(err instanceof Error ? err.stack : err)}`);
  process.exit(1);
});
