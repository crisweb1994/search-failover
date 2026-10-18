import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import type { Runtime } from './runtime.js';
import { log } from './logger.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Bearer token；绑定非本机地址时必填 */
  token?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK.has(h) || h === '::1';
}

/** Host 头或 Origin 里的主机名（去掉端口；IPv6 保留方括号）；解析不了返回 undefined */
function hostnameOf(value: string | undefined, isOrigin = false): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** 定长比较，避免按字节提前返回泄露 token */
function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** token 可以放在 Authorization: Bearer 头里，也可以放在 ?token= 里（有些平台只能填一个 URL） */
function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers.authorization;
  if (header !== undefined) return sameSecret(header, `Bearer ${token}`);
  const query = url.searchParams.get('token');
  return query !== null && sameSecret(query, token);
}

function reply(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }).end(body);
}

/**
 * Streamable HTTP（无状态）：每个 POST /mcp 新建一个 McpServer + transport，但共用同一个 runtime，
 * 所以计数、冷却和缓存在所有客户端之间共享。不提供 GET 通知流（无状态模式用不到）。
 * 配了 token 就以 token 鉴权（反向代理转发的公网 Host 也能用）；没配 token 只允许绑定本机地址
 * （由 startHttp 检查），并校验 Host / Origin，防止网页借 DNS rebinding 调用本机服务。
 */
export function createHttpServer(rt: Runtime, opts: HttpOptions): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return reply(res, 200, 'ok');
    if (url.pathname !== '/mcp') return reply(res, 404, 'not found');
    if (opts.token) {
      if (!authorized(req, url, opts.token)) return reply(res, 401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
    } else {
      if (!LOOPBACK.has(hostnameOf(req.headers.host) ?? '')) return reply(res, 403, 'forbidden host');
      const origin = req.headers.origin;
      if (origin && !LOOPBACK.has(hostnameOf(origin, true) ?? '')) return reply(res, 403, 'forbidden origin');
    }
    if (req.method !== 'POST') return reply(res, 405, 'method not allowed', { Allow: 'POST' });

    const server = createMcpServer(rt);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  return createServer((req, res) => {
    handle(req, res).catch(err => {
      log.error(`http request failed: ${String(err instanceof Error ? err.stack : err)}`);
      if (!res.headersSent) reply(res, 500, 'internal error');
      else res.end();
    });
  });
}

export async function startHttp(rt: Runtime, opts: HttpOptions): Promise<Server> {
  if (!isLoopback(opts.host) && !opts.token) {
    throw new Error(`refusing to listen on ${opts.host} without SEARCH_FAILOVER_HTTP_TOKEN (only loopback addresses may run without a token)`);
  }
  const server = createHttpServer(rt, opts);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  log.info(`listening on http://${host}:${port}/mcp${opts.token ? ' (bearer token required)' : ''}`);
  return server;
}
