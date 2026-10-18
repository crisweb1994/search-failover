import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'plugin-sync-'));
const script = join(root, 'scripts/plugin-sync.mjs');
const readText = (path: string) => readFileSync(join(root, path), 'utf8');
const read = (path: string) => JSON.parse(readText(path));
const write = (path: string, value: unknown) => writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20000 });
beforeAll(() => {
  for (const path of ['package.json', 'plugin', 'marketplace.json', '.agents/plugins', '.cursor-plugin', 'scripts/plugin-sync.mjs', 'src', 'README.md', 'README.en.md']) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(resolve(path), join(root, path), { recursive: true });
  }
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('结构错误：--check 与写模式都失败，文件保持原样', () => {
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
    ['plugin/.zcode-plugin/plugin.json', d => { d.userConfig.config_path.sensitive = true; }],
    ['plugin/.zcode-plugin/plugin.json', d => { delete d.userConfig.providers.default; }],
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
  const readme = readText('README.md');
  try {
    write('README.md', readme.replace('<!-- generated:providers -->', ''));
    for (const args of [['--check'], []]) expect(run(...args).status).toBe(1);
  } finally { write('README.md', readme); }
}, 60000);

it('漂移：--check 拒绝；写模式同步版本、重新生成 Cursor 变量与 README 表格，并保留宿主未知字段', () => {
  const pkg = read('package.json'); pkg.version = '9.8.7'; write('package.json', pkg);
  const cursor = read('plugin/.cursor-plugin/plugin.json');
  cursor.extra = { keep: true };
  cursor.mcpServers['search-failover'].env = { KEY: '${UNDECLARED}' };
  delete cursor.variables.properties.BOCHA_API_KEY;
  write('plugin/.cursor-plugin/plugin.json', cursor);
  write('README.en.md', readText('README.en.md').replace('| Exa |', '| Exa (stale) |'));

  const check = run('--check');
  expect(check.status).toBe(1);
  expect(check.stderr).toContain('README.en.md');
  expect(check.stderr).toContain('variables');
  expect(run().status).toBe(0);
  expect(run('--check').status).toBe(0);

  const synced = read('plugin/.cursor-plugin/plugin.json');
  expect(synced.extra).toEqual({ keep: true });
  expect(synced.variables.properties.BOCHA_API_KEY).toMatchObject({ type: 'string' });
  expect(synced.mcpServers['search-failover'].env).toMatchObject({
    BOCHA_API_KEY: '${BOCHA_API_KEY}', SEARXNG_URL: '${SEARXNG_URL}',
    SEARCH_FAILOVER_PROVIDERS: '${PROVIDERS}', SEARCH_FAILOVER_CONFIG: '${CONFIG_PATH}',
  });
  expect(readText('README.en.md')).not.toContain('(stale)');
  for (const path of ['plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.mcp.json']) {
    expect(read(path).mcpServers['search-failover'].args).toEqual(['-y', 'search-failover@9.8.7']);
  }
}, 60000);
