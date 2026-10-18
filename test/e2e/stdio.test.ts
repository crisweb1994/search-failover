import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CREDENTIAL_ENVS, PROVIDERS } from '../../src/providers/registry.js';
import { VERSION } from '../../src/version.js';

// 空的用户级配置目录：不读开发机上的 ~/.config/search-failover/config.json
const dir = mkdtempSync(join(tmpdir(), 'search-failover-stdio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const BASE_ENV = { LOG: 'info', XDG_CONFIG_HOME: dir, ...Object.fromEntries(CREDENTIAL_ENVS.map(name => [name, ''])) };

async function withServer(env: Record<string, string>, run: (client: Client, stderr: () => string) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    cwd: process.cwd(),
    env: { ...BASE_ENV, ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'test', version: '0' });
  const errors: Error[] = [];
  client.onerror = error => errors.push(error);
  try {
    await client.connect(transport, { timeout: 15000 });
    await run(client, () => stderr);
  } finally {
    await client.close();
    await transport.close();
  }
  expect(errors).toEqual([]);
}

const text = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe('stdio e2e', () => {
  it('零配置：web_search / web_search_status、instructions、只读标注；DDG 可用，其余未配置', async () => {
    await withServer({}, async client => {
      expect(client.getInstructions()).toContain('fallback_chain');
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toEqual(['web_search', 'web_search_status']);
      expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools[0]!.description).toContain('Active chain: duckduckgo.');
      const status = text(await client.callTool({ name: 'web_search_status', arguments: {} }));
      const byName = Object.fromEntries(status.providers.map((p: { name: string; state: string }) => [p.name, p.state]));
      expect(status.providers).toHaveLength(PROVIDERS.length);
      expect(byName['duckduckgo']).toBe('active');
      expect(byName['bocha']).toBe('unconfigured');
      expect(byName['zhipu']).toBe('unconfigured');
      expect(status).toMatchObject({ version: VERSION, config: { source: null, error: null, warnings: [] }, network: { proxy: null } });
    });
  }, 25000);

  it('配置文件拼错字段：照常启动，每次搜索都返回具体位置，status 里也能看到', async () => {
    const config = join(dir, 'typo.json');
    writeFileSync(config, JSON.stringify({ providers: [{ name: 'zhipu', quota: { type: 'one_time', limt: 100 } }] }));
    await withServer({ SEARCH_FAILOVER_CONFIG: config }, async (client, stderr) => {
      const result = await client.callTool({ name: 'web_search', arguments: { query: 'q' } });
      expect(result.isError).toBe(true);
      expect(text(result).meta.fallback_chain[0]).toMatchObject({
        outcome: 'config_error', detail: `${config}: providers.0.quota: unknown field "limt"`,
      });
      expect(text(await client.callTool({ name: 'web_search_status', arguments: {} })).config.error).toContain('limt');
      expect(stderr()).toContain('config error');
    });
  }, 25000);

  it('宿主没展开的模板不会被当成 key；SEARCH_FAILOVER_PROVIDERS 决定运行链', async () => {
    await withServer({ BOCHA_API_KEY: '${env:BOCHA_API_KEY}', SEARCH_FAILOVER_PROVIDERS: 'bocha,duckduckgo' }, async client => {
      const { tools } = await client.listTools();
      expect(tools[0]!.description).toContain('Active chain: duckduckgo.');
      const status = text(await client.callTool({ name: 'web_search_status', arguments: {} }));
      expect(status.providers[0]).toMatchObject({ name: 'bocha', in_chain: true, state: 'unconfigured', credential_env: 'BOCHA_API_KEY' });
      expect(status.config.warnings).toEqual([expect.stringContaining('BOCHA_API_KEY looks like an unexpanded template')]);
    });
  }, 25000);

  it('--version / --help 直接输出并退出', () => {
    const run = (arg: string) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', arg], { encoding: 'utf8', timeout: 15000 });
    expect(run('--version')).toMatchObject({ status: 0, stdout: `${VERSION}\n` });
    expect(run('--help').stdout).toContain('--http');
  }, 20000);
});
