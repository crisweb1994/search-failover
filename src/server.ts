import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Runtime } from './runtime.js';
import { INSTRUCTIONS, STATUS_DESCRIPTION, searchDescription } from './providers/describe.js';
import { buildSearchInput, makeSearchHandler } from './tools/search.js';
import { makeStatusHandler } from './tools/status.js';
import { VERSION } from './version.js';

/**
 * 组装 MCP server：stdio 模式建一次；HTTP 无状态模式每个请求建一次，但共用同一个 runtime。
 * 工具名带 web_ 前缀，避免在不做命名空间的宿主里和其他 server 的 search/status 撞名。
 */
export function createMcpServer(rt: Runtime): McpServer {
  const server = new McpServer({ name: 'search-failover', version: VERSION }, { instructions: INSTRUCTIONS });
  server.registerTool('web_search', {
    title: 'Web Search',
    description: searchDescription(rt),
    inputSchema: buildSearchInput(rt),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, makeSearchHandler(rt));
  server.registerTool('web_search_status', {
    title: 'Web Search Status',
    description: STATUS_DESCRIPTION,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, makeStatusHandler(rt));
  return server;
}
