import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttp } from '../../src/http.js';
import { testRuntime } from '../helpers.js';

const search = vi.fn(async () => [{ title: 'r', url: 'https://x.test' }]);
const rt = testRuntime([{ name: 'exa', maxCount: 20, includeDomains: 'native', search }]);
let server: Server;
let port: number;
let open: Server;
let openPort: number;

beforeAll(async () => {
  server = await startHttp(rt, { host: '127.0.0.1', port: 0, token: 'secret' });
  port = (server.address() as AddressInfo).port;
  open = await startHttp(rt, { host: '127.0.0.1', port: 0 });
  openPort = (open.address() as AddressInfo).port;
});
afterAll(() => {
  for (const s of [server, open]) {
    s.closeAllConnections();
    s.close();
  }
});

async function connect(token = 'secret'): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

/** 用 http.request 发原始请求，便于伪造 Host / Origin 头 */
function raw(path: string, method: string, headers: Record<string, string>, to = port): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: to, path, method, headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) : undefined);
  });
}

const json = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('Streamable HTTP 模式', () => {
  it('两个客户端共用同一份 runtime：第二个客户端命中第一个写入的缓存', async () => {
    const a = await connect();
    const b = await connect();
    try {
      expect(a.getInstructions()).toContain('fallback_chain');
      expect((await a.listTools()).tools.map(t => t.name)).toEqual(['web_search', 'web_search_status']);
      const first = await a.callTool({ name: 'web_search', arguments: { query: 'shared' } });
      const second = await b.callTool({ name: 'web_search', arguments: { query: 'shared' } });
      const meta = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text).meta;
      expect(meta(first)).toMatchObject({ provider_used: 'exa', cache_hit: false });
      expect(meta(second)).toMatchObject({ provider_used: 'exa', cache_hit: true });
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('缺 token 或 token 错误 → 401；token 也可以放在 ?token= 里', async () => {
    expect((await raw('/mcp', 'POST', json)).status).toBe(401);
    const wrong = await raw('/mcp', 'POST', { ...json, Authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe('Bearer');
    expect((await raw('/mcp?token=nope', 'POST', json)).status).toBe(401);
    expect((await raw('/mcp?token=secret', 'POST', json)).status).toBe(200);
    await expect(connect('nope')).rejects.toThrow();
  });

  it('配了 token 就以 token 为准：反向代理转发的公网 Host 也能用', async () => {
    expect((await raw('/mcp', 'POST', { ...json, Authorization: 'Bearer secret', Host: 'search.example.com' })).status).toBe(200);
  });

  it('没配 token 时拒绝非本机的 Host / Origin（防 DNS rebinding）', async () => {
    expect((await raw('/mcp', 'POST', json, openPort)).status).toBe(200);
    expect((await raw('/mcp', 'POST', { ...json, Host: 'evil.example:1234' }, openPort)).status).toBe(403);
    expect((await raw('/mcp', 'POST', { ...json, Origin: 'https://evil.example' }, openPort)).status).toBe(403);
    expect((await raw('/mcp', 'POST', { ...json, Origin: 'http://localhost:6274' }, openPort)).status).toBe(200);
  });

  it('GET → 405；未知路径 404；/healthz 200', async () => {
    expect((await raw('/mcp', 'GET', { Authorization: 'Bearer secret' })).status).toBe(405);
    expect((await raw('/other', 'GET', {})).status).toBe(404);
    expect((await raw('/healthz', 'GET', {})).status).toBe(200);
  });

  it('绑定非本机地址却没有 token 时拒绝启动', async () => {
    await expect(startHttp(rt, { host: '0.0.0.0', port: 0 })).rejects.toThrow('SEARCH_FAILOVER_HTTP_TOKEN');
  });
});
