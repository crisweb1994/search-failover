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
  '每条结果必有 title/url；正文在 content（来源给较长摘要时）或 snippet（只有短摘要时），二者不同时出现，也可能都缺失，缺失时请自行访问 url；publishedDate/score 为部分源提供的可选字段。',
  'publishedDate 尽力而为；freshness 由各源执行，粒度和日期语义可能不同（千帆 day 会忽略并提示）。',
  `仅搜特定域名用 include_domains（${domainFilterDescribe()}）。`,
  '相同查询、条数和过滤条件可命中缓存（默认 TTL 1 小时，day 为 15 分钟，可配置；use_cache=false 绕过读写）；空结果需查看 fallback_chain；错误或跳过导致搜索未完成时 isError=true。总预算内不保证尝试全部来源；DDG 免 key，但可用性取决于网络和反爬限制。',
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

  const deps = { config, providers, state, cache };

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
