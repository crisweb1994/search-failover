#!/usr/bin/env node
import pkg from '../package.json' with { type: 'json' };
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isConfigured } from './credentials.js';
import { loadConfig } from './config.js';
import { ResultCache } from './cache.js';
import { GatewayState } from './state.js';
import { REGISTRY } from './providers/registry.js';
import { defaultChainDescribe, domainFilterDescribe } from './providers/describe.js';
import { makeSearchHandler, searchInput } from './tools/search.js';
import { makeStatusHandler } from './tools/status.js';
import { log } from './logger.js';

const SEARCH_DESCRIPTION = [
  '聚合网页搜索（顺序容灾，任一来源限额、超时或空结果时自动切换下一家）。',
  '每条结果必有 title/url/snippet；content/publishedDate/score 为部分源提供的可选字段（可能缺失，缺失时请自行访问 url）。',
  'publishedDate 尽力而为、不保证精确；严格时间过滤请用 freshness 参数（服务端过滤）。',
  `仅搜特定域名用 include_domains（${domainFilterDescribe()}）。`,
  '同参数 1 小时内命中缓存（use_cache=false 可关闭）；返回 results: [] 表示全部源均未搜到，可改写查询后重试。',
  defaultChainDescribe(),
].join('');

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new GatewayState();
  const cache = new ResultCache(config.cache);

  // 进入运行链 = enabled（用户意愿）× isConfigured（凭据可用，D14/D15）
  const providers = config.providers
    .filter(p => p.enabled && REGISTRY[p.name] && isConfigured(p.name))
    .sort((a, b) => a.priority - b.priority)
    .map(cfg => ({ cfg, adapter: REGISTRY[cfg.name]!.adapter }));

  const deps = { config, allProviders: config.providers, providers, state, cache };

  const server = new McpServer({ name: 'search-failover', version: pkg.version });
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
