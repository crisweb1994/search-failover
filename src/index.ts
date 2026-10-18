#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { readEnv } from './env.js';
import { startHttp } from './http.js';
import { log } from './logger.js';
import { initNetwork } from './net.js';
import { buildRuntime } from './runtime.js';
import { createMcpServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = `search-failover ${VERSION}

Usage:
  search-failover                        stdio MCP server (default)
  search-failover --http [--host 127.0.0.1] [--port 8787]
                                         Streamable HTTP MCP server at /mcp
  search-failover --version | --help

Environment:
  BOCHA_API_KEY, TAVILY_API_KEY, ...     provider credentials (SEARXNG_URL for SearXNG)
  SEARCH_FAILOVER_PROVIDERS              chain in priority order, e.g. tavily,brave,duckduckgo
  SEARCH_FAILOVER_CONFIG                 config file (default ~/.config/search-failover/config.json)
  SEARCH_FAILOVER_HTTP_TOKEN             bearer token for --http (required unless bound to loopback)
  HTTPS_PROXY, HTTP_PROXY, NO_PROXY      outbound proxy
  LOG                                    error | warn | info | debug (written to stderr)
`;

const KNOWN_OPTIONS = new Set(['http', 'host', 'port', 'help', 'version']);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean' },
      host: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    strict: false,
  });
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  if (values.help) return void process.stdout.write(USAGE);
  // 未知参数只告警：插件锁定的旧版本遇到新参数时仍能启动
  for (const key of Object.keys(values)) {
    if (!KNOWN_OPTIONS.has(key)) log.warn(`ignoring unknown option --${key}`);
  }

  const network = await initNetwork();
  const loaded = loadConfig();
  const rt = buildRuntime(loaded, { network });
  // 配置出错不退出：照常启动，每次搜索都返回这条错误，宿主对话里就能看到
  if (loaded.error) log.error(`config error (every search fails until it is fixed): ${loaded.error}`);
  for (const warning of rt.warnings) log.warn(warning);

  if (values.http) {
    if (values.port !== undefined && typeof values.port !== 'string') throw new Error('--port needs a value');
    const port = values.port === undefined ? 8787 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port ${String(values.port)}`);
    const host = typeof values.host === 'string' ? values.host : '127.0.0.1';
    const server = await startHttp(rt, { host, port, token: readEnv('SEARCH_FAILOVER_HTTP_TOKEN') });
    const stop = () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else {
    await createMcpServer(rt).connect(new StdioServerTransport());
  }
  const chain = rt.providers.map(p => p.cfg.name).join(' -> ') || '(none)';
  log.info(`search-failover ${VERSION} ready; chain: ${chain}${network.proxy ? `; proxy: ${network.proxy}` : ''}`);
}

main().catch(err => {
  log.error(`startup failed: ${String(err instanceof Error ? err.stack : err)}`);
  process.exit(1);
});
