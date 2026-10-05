import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REGISTRY } from '../../src/providers/registry.js';

describe('stdio e2e', () => {
  it('起服 → initialize → tools/list → status 调用；stdout 无协议错误', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-failover-stdio-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, '{}');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '', LOG: 'error', SEARCH_FAILOVER_CONFIG: config,
        BOCHA_API_KEY: '', TAVILY_API_KEY: '', BRAVE_API_KEY: '', EXA_API_KEY: '',
        ZHIPU_API_KEY: '', QIANFAN_API_KEY: '', SERPER_API_KEY: '',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0' });
    const errors: Error[] = [];
    client.onerror = error => errors.push(error);
    try {
      await client.connect(transport, { timeout: 15000 });
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toEqual(expect.arrayContaining(['search', 'status']));
      const status = await client.callTool({ name: 'status', arguments: {} });
      const payload = JSON.parse((status.content as { text: string }[])[0]!.text);
      const byName = Object.fromEntries(payload.providers.map((p: { name: string; state: string }) => [p.name, p.state]));
      expect(payload.providers).toHaveLength(Object.keys(REGISTRY).length);
      expect(byName['duckduckgo']).toBe('active');
      expect(byName['bocha']).toBe('unconfigured');
      expect(byName['zhipu']).toBe('unconfigured');
      expect(typeof payload.uptime_s).toBe('number');
    } finally {
      await client.close();
      await transport.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(errors).toEqual([]);
  }, 25000);
});
