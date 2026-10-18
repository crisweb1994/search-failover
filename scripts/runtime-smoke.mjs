/** 打包产物 stdio smoke：真实 SDK/子进程，fetch 为本地构造响应，不消耗供应商额度。用法：node scripts/runtime-smoke.mjs [dist/index.js] */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = resolve(process.argv[2] ?? 'dist/index.js');
const dir = mkdtempSync(join(tmpdir(), 'search-failover-smoke-'));
const config = join(dir, 'config.json');
const mock = join(dir, 'mock.mjs');
writeFileSync(config, JSON.stringify({ providers: [{ name: 'duckduckgo', min_interval_ms: 0 }] }));
writeFileSync(mock, `globalThis.fetch = async () => new Response('<div class="result"><a class="result__a" href="https://example.com">Smoke result</a></div>');`);
const client = new Client({ name: 'runtime-smoke', version: '1' });
const transport = new StdioClientTransport({
  command: process.execPath,
  // Windows 上 --import 只接受 URL，不接受 C:\ 开头的路径
  args: ['--import', pathToFileURL(mock).href, entry],
  env: { SEARCH_FAILOVER_CONFIG: config, LOG: 'error' },
  stderr: 'pipe',
});
const text = result => JSON.parse(result.content[0].text);
try {
  await client.connect(transport);
  assert.match(client.getInstructions() ?? '', /fallback_chain/);
  const { tools } = await client.listTools();
  const search = tools.find(t => t.name === 'web_search');
  assert.ok(search && tools.some(t => t.name === 'web_search_status'));
  assert.equal(search.annotations?.readOnlyHint, true);
  assert.match(search.description ?? '', /Active chain: duckduckgo\./);

  const cold = await client.callTool({ name: 'web_search', arguments: { query: ' smoke ', max_results: 1 } });
  assert.equal(cold.isError, false);
  assert.equal(text(cold).results[0].title, 'Smoke result');
  assert.equal(text(cold).meta.provider_used, 'duckduckgo');
  const warm = await client.callTool({ name: 'web_search', arguments: { query: 'smoke', max_results: '1' } });
  assert.equal(text(warm).meta.cache_hit, true);
  const more = await client.callTool({ name: 'web_search', arguments: { query: 'smoke', max_results: 99, include_domains: ['https://example.com/docs'] } });
  assert.equal(text(more).meta.cache_hit, false);
  assert.equal(more.isError, false);
  const invalid = await client.callTool({ name: 'web_search', arguments: { query: '  ' } });
  assert.equal(invalid.isError, true);

  const status = text(await client.callTool({ name: 'web_search_status', arguments: {} }));
  assert.equal(status.providers[0].name, 'duckduckgo');
  assert.equal(status.providers[0].used_requests, 2);
  assert.equal(status.cache.entries, 2);
  assert.equal(status.config.error, null);
  console.log(`stdio smoke passed (${process.version}; mocked upstream; ${entry})`);
} finally {
  await client.close();
  await transport.close();
  rmSync(dir, { recursive: true, force: true });
}
