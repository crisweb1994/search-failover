/** 打包产物 stdio smoke：真实 SDK/子进程，fetch 为本地构造响应，不消耗供应商额度。 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dir = mkdtempSync(join(tmpdir(), 'search-failover-smoke-'));
const config = join(dir, 'config.json');
const mock = join(dir, 'mock.mjs');
writeFileSync(config, JSON.stringify({ providers: [{ name: 'duckduckgo', min_interval_ms: 0 }] }));
writeFileSync(mock, `globalThis.fetch = async () => new Response('<div class="result"><a class="result__a" href="https://example.com">Smoke result</a></div>');`);
const client = new Client({ name: 'runtime-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', mock, resolve(process.argv[2] ?? 'dist/index.js')],
  env: { PATH: process.env.PATH ?? '', SEARCH_FAILOVER_CONFIG: config, LOG: 'error' },
  stderr: 'pipe',
});
try {
  await client.connect(transport);
  const list = await client.listTools();
  assert(list.tools.some(t => t.name === 'search'));
  const result = await client.callTool({ name: 'search', arguments: { query: ' smoke ', max_results: 1 } });
  assert.equal(result.isError, false);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.results[0].title, 'Smoke result');
  assert.equal(payload.meta.provider_used, 'duckduckgo');
  const invalid = await client.callTool({ name: 'search', arguments: { query: '  ' } });
  assert.equal(invalid.isError, true);
  const unavailable = await client.callTool({ name: 'search', arguments: { query: 'q', provider: 'missing' } });
  assert.equal(unavailable.isError, true);
  const status = await client.callTool({ name: 'status', arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).providers[0].used_requests, 1);
  console.log(`stdio smoke passed (${process.version}; mocked upstream; ${process.argv[2] ?? 'dist/index.js'})`);
} finally {
  await client.close();
  await transport.close();
  rmSync(dir, { recursive: true, force: true });
}
