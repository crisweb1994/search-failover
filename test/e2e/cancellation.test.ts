import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { configSchema } from '../../src/config.js';
import { GatewayState } from '../../src/state.js';
import { ResultCache } from '../../src/cache.js';
import { makeSearchHandler, searchInput } from '../../src/tools/search.js';
import { rawRequest } from '../../src/providers/types.js';

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{"results":['); // headers 已到，body 永不完成
});
let url: string;
beforeAll(async () => {
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  url = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
});
afterAll(async () => {
  httpServer.closeAllConnections();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

it('真实 HTTP 响应体读取超时归类为 timeout', async () => {
  await expect(rawRequest(url, {}, 'p1', AbortSignal.timeout(80))).rejects.toMatchObject({ type: 'timeout' });
});

describe('SDK cancellation → handler → pace / fetch', () => {
  it.each(['pace', 'body'])('%s 取消不 fallback、不缓存、不冷却', async stage => {
    const config = configSchema.parse({ providers: [{ name: 'p1', min_interval_ms: stage === 'pace' ? 1000 : 0 }, { name: 'p2' }] });
    const state = new GatewayState();
    const cache = new ResultCache(config.cache);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = vi.fn(async (_req, _count, signal: AbortSignal) => {
      const request = rawRequest(url, {}, 'p1', signal);
      started();
      await request;
      return [];
    });
    const second = vi.fn(async () => []);
    const providers = [
      { cfg: config.providers[0]!, adapter: { name: 'p1', maxCount: 20, search: first } },
      { cfg: config.providers[1]!, adapter: { name: 'p2', maxCount: 20, search: second } },
    ];
    if (stage === 'pace') await state.pace('p1', config.providers[0]!, Date.now() + 1000);
    const handler = makeSearchHandler({ config, providers, state, cache });
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const server = new McpServer({ name: 'cancel-test', version: '1' });
    server.registerTool('search', { inputSchema: searchInput }, async (args, extra) => {
      if (stage === 'pace') started();
      try { return await handler(args, extra); }
      finally { finish(); }
    });
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const controller = new AbortController();
      const pending = client.callTool({ name: 'search', arguments: { query: 'q' } }, undefined, { signal: controller.signal });
      const rejected = expect(pending).rejects.toBeDefined();
      await ready;
      controller.abort();
      await rejected;
      await finished;
      expect(first).toHaveBeenCalledTimes(stage === 'pace' ? 0 : 1);
      expect(second).not.toHaveBeenCalled();
      expect(cache.size).toBe(0);
      expect(state.checkBlocked('p1')).toBeNull();
      expect(state.used('p1', config.providers[0]!)).toBe(stage === 'pace' ? 0 : 1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
