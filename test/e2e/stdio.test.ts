import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REGISTRY } from '../../src/providers/registry.js';

describe('stdio e2e', () => {
  it.each(['default', 'legacy-fields'])('%s 起服 → initialize → tools/list → status；废弃字段静默兼容', async mode => {
    const dir = mkdtempSync(join(tmpdir(), 'search-failover-stdio-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify(mode === 'default' ? {} : {
      providers: Object.keys(REGISTRY).map(name => name === 'bocha'
        ? { name, fetch_policy: 'cache_fill', quota: { quota_retry_s: 600 } }
        : { name }),
      cache: { store_size: 2 },
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts'],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? '', LOG: 'info', SEARCH_FAILOVER_CONFIG: config,
        BOCHA_API_KEY: '', TAVILY_API_KEY: '', BRAVE_API_KEY: '', EXA_API_KEY: '',
        ZHIPU_API_KEY: '', QIANFAN_API_KEY: '', SERPER_API_KEY: '',
      },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });
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
    expect(stderr).not.toContain('配置迁移');
  }, 25000);

  it('配置里有拼错的字段 → 启动失败并指出位置', () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-failover-badconfig-'));
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ providers: [{ name: 'zhipu', quota: { type: 'one_time', limt: 100 } }] }));
    try {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
        env: { PATH: process.env.PATH ?? '', LOG: 'error', SEARCH_FAILOVER_CONFIG: config },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('providers.0.quota: 未知字段 limt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
