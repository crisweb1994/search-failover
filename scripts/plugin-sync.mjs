#!/usr/bin/env node
/**
 * 插件清单与文档同步。
 * - 写模式：从来源注册表重新生成 Cursor 插件的 variables/env 和 README 里的来源表格。
 * - --to <x.y.z>：把清单版本和 npx 锁定版本改成 x.y.z（发布 workflow 在 npm 发布成功后调用）。
 * - --check：只校验不写；--published：再确认锁定的版本在 npm 上已经能装到。
 * 清单锁定的是"最新已发布版本"，可以落后于 package.json（那是下一个要发的版本），但不能超前：
 * 市场直接读 GitHub 默认分支，锁定的版本必须先能装到。注册表是 TypeScript，经 tsx 加载；先 npm ci。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { z } from 'zod';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => join(repoRoot, p);
const published = process.argv.includes('--published');
const checkOnly = published || process.argv.includes('--check');
const toIndex = process.argv.indexOf('--to');
const target = toIndex === -1 ? undefined : process.argv[toIndex + 1];
const errors = [];
if (toIndex !== -1 && !/^\d+\.\d+\.\d+$/.test(target ?? '')) errors.push(`--to 需要 x.y.z 形式的版本号，实际为 ${target ?? '(空)'}`);
if (toIndex !== -1 && checkOnly) errors.push('--to 不能和 --check / --published 同时使用');
const jsonPaths = [
  'package.json', 'plugin/plugin.json', 'plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json',
  'plugin/.zcode-plugin/plugin.json', 'plugin/.mcp.json', '.agents/plugins/marketplace.json',
  'marketplace.json', '.cursor-plugin/marketplace.json',
];
const docs = Object.fromEntries(jsonPaths.map(path => {
  try { return [path, JSON.parse(readFileSync(rel(path), 'utf8'))]; }
  catch (err) { errors.push(`${path}: ${err.message}`); return [path, undefined]; }
}));
function failIfErrors() {
  if (!errors.length) return;
  console.error(`✗ plugin ${checkOnly ? 'check' : 'sync'} 失败：\n${errors.join('\n')}`);
  process.exit(1);
}
failIfErrors();

// ---------------------------------------------------------------- 结构校验（只验证，保留宿主的未知字段）
const text = z.string().min(1);
const object = shape => z.object(shape).passthrough();
const directory = path => existsSync(rel(path)) && statSync(rel(path)).isDirectory();
const localSource = text.startsWith('./').refine(directory, '来源目录不存在');
const manifest = object({ name: z.literal('search-failover'), version: text.optional() });
const server = object({
  type: z.literal('stdio'), command: text.regex(/^\S+$/),
  args: z.tuple([z.literal('-y'), z.string().startsWith('search-failover@')]),
  env: z.record(z.string()).optional(),
});
const mcp = object({ mcpServers: object({ 'search-failover': server }) });
const market = entry => object({ name: text, plugins: z.array(object({ name: text, ...entry })).min(1) });
const schemas = {
  'package.json': object({ version: z.string().regex(/^\d+\.\d+\.\d+/) }),
  'plugin/plugin.json': manifest.extend({
    $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'),
    version: text, description: text, extensions: z.record(z.unknown()).optional(),
    author: z.unknown(), homepage: z.unknown(), repository: z.unknown(),
    license: z.unknown(), keywords: z.unknown(),
  }).strict(),
  'plugin/mcp.json': mcp.extend({
    $schema: z.literal('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'),
  }).strict(),
  'plugin/.cursor-plugin/plugin.json': manifest.extend({
    variables: object({ type: z.literal('object'), properties: z.record(object({ type: z.string() })) }),
    mcpServers: mcp.shape.mcpServers,
  }),
  'plugin/.zcode-plugin/plugin.json': manifest.extend({
    mcpServers: z.string().refine(p => existsSync(rel(join('plugin', p.replace(/^\.\//, '')))), 'MCP 文件不存在'),
    userConfig: z.record(object({
      type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
      sensitive: z.unknown().refine(v => v !== true, '敏感项必须走宿主环境变量或用户级配置文件'),
    })),
  }),
  'plugin/.mcp.json': mcp,
  '.agents/plugins/marketplace.json': market({
    source: object({ source: z.literal('local'), path: localSource }), category: text,
    policy: object({ installation: z.enum(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']), authentication: text }),
  }),
  'marketplace.json': market({ source: localSource, version: text.optional() }),
  '.cursor-plugin/marketplace.json': market({
    source: text.refine(p => !p.startsWith('.') && directory(p) && existsSync(rel(join(p, '.cursor-plugin/plugin.json'))), '来源必须包含 Cursor 插件清单'),
  }).extend({ owner: object({ name: text }) }),
};
for (const [path, schema] of Object.entries(schemas)) {
  const result = schema.safeParse(docs[path]);
  if (!result.success) {
    for (const issue of result.error.issues) errors.push(`${path}:${issue.path.join('.')}: ${issue.message}`);
  }
}
failIfErrors();

const serverOf = doc => doc.mcpServers['search-failover'];
const agentMcp = docs['plugin/mcp.json'];
const cursorManifest = docs['plugin/.cursor-plugin/plugin.json'];
const zcodeManifest = docs['plugin/.zcode-plugin/plugin.json'];
const zcodeMcp = docs['plugin/.mcp.json'];

// 占位符展开规则由各宿主分别约束，不能共用一种 env 模板。
for (const [key, value] of Object.entries(serverOf(agentMcp).env ?? {})) {
  if (value.includes('${') || ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key)) {
    errors.push(`plugin/mcp.json: env.${key} 禁止占位符或保留变量`);
  }
}
for (const [key, value] of Object.entries(serverOf(zcodeMcp).env ?? {})) {
  const match = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(value);
  const config = match && zcodeManifest.userConfig[match[1]];
  if (!config || !Object.hasOwn(config, 'default')) {
    errors.push(`plugin/.mcp.json: env.${key} 必须引用已声明且带 default 的 user_config 键`);
  }
}
const skillPath = 'plugin/skills/web-search/SKILL.md';
try {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(rel(skillPath), 'utf8'));
  if (!fm || !/^name:\s*\S+/m.test(fm[1]) || !/^description:\s*\S+/m.test(fm[1])) {
    errors.push(`${skillPath}: frontmatter 必须包含 name/description`);
  }
} catch (err) { errors.push(`${skillPath}: ${err.message}`); }
failIfErrors();

// ---------------------------------------------------------------- 从注册表生成
const { PROVIDERS } = await tsImport('../src/providers/registry.ts', import.meta.url);
const credentialed = PROVIDERS.filter(def => def.credentialEnv);

/** Cursor 插件：每个凭据一个变量，外加运行链与配置文件路径 */
function cursorVariables() {
  const properties = {};
  for (const def of credentialed) {
    const isUrl = def.credentialEnv.endsWith('_URL');
    properties[def.credentialEnv] = {
      type: 'string',
      title: isUrl ? `${def.label} URL` : `${def.label} API key`,
      description: isUrl
        ? 'Optional. Base URL of your instance, e.g. http://localhost:8080 (enable the json format in its settings).'
        : def.defaultEnabled ? 'Optional.' : 'Optional. Opt-in provider: also list it in Providers.',
    };
  }
  properties.PROVIDERS = {
    type: 'string',
    title: 'Providers',
    description: 'Optional. Provider chain in priority order, e.g. tavily,brave,duckduckgo. Leave empty for the default chain.',
  };
  properties.CONFIG_PATH = {
    type: 'string',
    title: 'Config file path',
    description: 'Optional. Absolute path to a config file. Defaults to ~/.config/search-failover/config.json.',
  };
  return properties;
}
function cursorEnv() {
  return {
    ...Object.fromEntries(credentialed.map(def => [def.credentialEnv, `\${${def.credentialEnv}}`])),
    SEARCH_FAILOVER_PROVIDERS: '${PROVIDERS}',
    SEARCH_FAILOVER_CONFIG: '${CONFIG_PATH}',
  };
}

const LANG = {
  zh: {
    header: '| 来源 | 配置变量 | 默认进链 | 本地预算 | `include_domains` |\n| --- | --- | --- | --- | --- |',
    none: '无需配置', yes: '是', no: '否（需显式列出）', url: '（实例地址）',
    quota: q => q.type === 'monthly' ? `每月 ${q.limit} 次，${q.reset_day ?? 1} 日重置` : q.limit !== undefined ? `累计 ${q.limit} 次` : '不限',
    domains: { native: '多个域名', single: '单个域名', none: '不支持' },
  },
  en: {
    header: '| Provider | Variable | In default chain | Local budget | `include_domains` |\n| --- | --- | --- | --- | --- |',
    none: 'none needed', yes: 'yes', no: 'no (opt-in, list it explicitly)', url: ' (instance URL)',
    quota: q => q.type === 'monthly' ? `${q.limit}/month, resets on day ${q.reset_day ?? 1}` : q.limit !== undefined ? `${q.limit} in total` : 'unlimited',
    domains: { native: 'multiple domains', single: 'one domain', none: 'not supported' },
  },
};
function providerTable(lang) {
  const t = LANG[lang];
  const rows = PROVIDERS.map(def => {
    const variable = def.credentialEnv ? `\`${def.credentialEnv}\`${def.credentialEnv.endsWith('_URL') ? t.url : ''}` : t.none;
    return `| ${def.label} | ${variable} | ${def.defaultEnabled ? t.yes : t.no} | ${t.quota(def.quota)} | ${t.domains[def.adapter.includeDomains]} |`;
  });
  return `${t.header}\n${rows.join('\n')}`;
}

const textDocs = { 'README.md': providerTable('zh'), 'README.en.md': providerTable('en') };
const textOut = {};
for (const [path, table] of Object.entries(textDocs)) {
  let content;
  try { content = readFileSync(rel(path), 'utf8'); } catch (err) { errors.push(`${path}: ${err.message}`); continue; }
  const block = /<!-- generated:providers -->[\s\S]*?<!-- \/generated:providers -->/;
  if (!block.test(content)) { errors.push(`${path}: 缺少 <!-- generated:providers --> 标记`); continue; }
  const next = content.replace(block, () => `<!-- generated:providers -->\n${table}\n<!-- /generated:providers -->`);
  if (next !== content) {
    if (checkOnly) errors.push(`${path}: 来源表格与注册表不一致（运行 npm run plugin:sync）`);
    textOut[path] = next;
  }
}

const expectEqual = (path, actual, expected, what) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${path}: ${what} 与注册表不一致（运行 npm run plugin:sync）`);
};
if (checkOnly) {
  expectEqual('plugin/.cursor-plugin/plugin.json', cursorManifest.variables.properties, cursorVariables(), 'variables');
  expectEqual('plugin/.cursor-plugin/plugin.json', serverOf(cursorManifest).env, cursorEnv(), 'env');
} else {
  cursorManifest.variables.properties = cursorVariables();
  serverOf(cursorManifest).env = cursorEnv();
}

// ---------------------------------------------------------------- 版本
const packageVersion = docs['package.json'].version;
const zcodeMarket = docs['marketplace.json'];
const manifests = [docs['plugin/plugin.json'], cursorManifest, zcodeManifest, zcodeMarket.plugins[0]];
const servers = [agentMcp, cursorManifest, zcodeMcp].map(serverOf);
if (target) {
  for (const doc of manifests) doc.version = target;
  for (const entry of servers) entry.args[1] = `search-failover@${target}`;
}
const pinned = docs['plugin/plugin.json'].version;
for (const path of ['plugin/.cursor-plugin/plugin.json', 'plugin/.zcode-plugin/plugin.json', 'marketplace.json']) {
  const actual = path === 'marketplace.json' ? zcodeMarket.plugins[0].version : docs[path].version;
  if (actual !== pinned) errors.push(`${path}: version 必须与 plugin/plugin.json 的 ${pinned} 一致`);
}
for (const path of ['plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.mcp.json']) {
  if (serverOf(docs[path]).args[1] !== `search-failover@${pinned}`) errors.push(`${path}: npx 锁定版本必须为 ${pinned}`);
}
const parts = v => String(v).split(/[.+-]/).slice(0, 3).map(Number);
const compare = (a, b) => parts(a).reduce((acc, n, i) => acc || n - parts(b)[i], 0);
if (compare(pinned, packageVersion) > 0) {
  errors.push(`清单锁定的 ${pinned} 不能高于 package.json 的 ${packageVersion}`);
}
if (published) {
  try {
    const found = execFileSync('npm', ['view', `search-failover@${pinned}`, 'version'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
    }).trim();
    if (found !== pinned) throw new Error(found || 'not found');
  } catch {
    errors.push(`npm 上没有 search-failover@${pinned}：清单只能锁定已发布的版本（由发布 workflow 在 npm 发布成功后更新）`);
  }
}
failIfErrors();

if (!checkOnly) {
  for (const path of ['plugin/plugin.json', 'plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.zcode-plugin/plugin.json', 'plugin/.mcp.json', 'marketplace.json']) {
    writeFileSync(rel(path), `${JSON.stringify(docs[path], null, 2)}\n`);
  }
  for (const [path, content] of Object.entries(textOut)) writeFileSync(rel(path), content);
}
console.log(`✓ plugin ${checkOnly ? 'check' : 'sync'} 通过：清单×3、市场清单×3、Cursor 变量与 README 来源表格（${PROVIDERS.length} 个来源），清单锁定 ${pinned}（package.json ${packageVersion}）${published ? '，npm 已发布' : ''}`);
