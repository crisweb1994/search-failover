import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'plugin-sync-'));
const script = join(root, 'scripts/plugin-sync.mjs');
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const write = (path: string, value: unknown) => writeFileSync(join(root, path), JSON.stringify(value));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
beforeAll(() => {
  for (const path of ['package.json', 'plugin', 'marketplace.json', '.agents/plugins', '.cursor-plugin', 'scripts/plugin-sync.mjs']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(resolve(path), join(root, path), { recursive: true });
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('保留宿主结构、引用、路径和版本约束；错误清单不能进入写模式', () => {
  expect(run('--check').status).toBe(0);
  const cases: [string, (doc: any) => void][] = [
    ['plugin/plugin.json', d => { d.unrecognized = true; }],
    ['plugin/plugin.json', d => { d.name = 'wrong'; }],
    ['plugin/plugin.json', d => { d.$schema = 'wrong'; }],
    ['plugin/plugin.json', d => { d.extensions = []; }],
    ['plugin/mcp.json', d => { d.mcpServers['search-failover'].command = 'npx -y'; }],
    ['plugin/mcp.json', d => { d.mcpServers['search-failover'].args = ['-y']; }],
    ['plugin/mcp.json', d => { d.mcpServers['search-failover'].env = { KEY: '${KEY}' }; }],
    ['plugin/mcp.json', d => { d.mcpServers['search-failover'].env = { PLUGIN_ROOT: '/tmp' }; }],
    ['plugin/.cursor-plugin/plugin.json', d => { d.variables = { KEY: { type: 'string' } }; }],
    ['plugin/.cursor-plugin/plugin.json', d => { d.mcpServers['search-failover'].env = { KEY: '${UNDECLARED}' }; }],
    ['plugin/.zcode-plugin/plugin.json', d => { d.userConfig.config_path.sensitive = true; }],
    ['plugin/.zcode-plugin/plugin.json', d => { delete d.userConfig.config_path.default; }],
    ['plugin/.zcode-plugin/plugin.json', d => { d.userConfig.config_path.type = 'unsupported'; }],
    ['plugin/.zcode-plugin/plugin.json', d => { d.mcpServers = './missing.json'; }],
    ['plugin/.mcp.json', d => { d.mcpServers['search-failover'].env = { KEY: '${user_config.missing}' }; }],
    ['plugin/.mcp.json', d => { d.mcpServers['search-failover'].env = { KEY: 'literal' }; }],
    ['.agents/plugins/marketplace.json', d => { d.plugins[0].source.path = './missing'; }],
    ['.agents/plugins/marketplace.json', d => { d.plugins[0].policy.installation = 'wrong'; }],
    ['marketplace.json', d => { d.plugins[0].source = './missing'; }],
    ['.cursor-plugin/marketplace.json', d => { d.plugins[0].source = 'scripts'; }],
    ['.cursor-plugin/marketplace.json', d => { delete d.owner; }],
  ];
  for (const [path, mutate] of cases) {
    const original = read(path);
    const changed = structuredClone(original); mutate(changed); write(path, changed);
    try {
      for (const args of [['--check'], []]) expect(run(...args).status, path).toBe(1);
      expect(read(path)).toEqual(changed);
    } finally { write(path, original); }
  }
}, 15000);

it('版本失配被拒绝；同步全部版本，同时保留宿主未知字段', () => {
  const pkg = read('package.json'); pkg.version = '9.8.7'; write('package.json', pkg);
  const cursor = read('plugin/.cursor-plugin/plugin.json'); cursor.extra = { keep: true }; write('plugin/.cursor-plugin/plugin.json', cursor);
  expect(run('--check').status).toBe(1);
  expect(run().status).toBe(0);
  expect(run('--check').status).toBe(0);
  expect(read('plugin/.cursor-plugin/plugin.json').extra).toEqual({ keep: true });
  for (const path of ['plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.mcp.json']) {
    expect(read(path).mcpServers['search-failover'].args).toEqual(['-y', 'search-failover@9.8.7']);
  }
});
