#!/usr/bin/env node
/** 同步插件版本并检查宿主契约；--check 只校验。复用项目依赖 Zod，先 npm ci。 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = p => join(repoRoot, p);
const checkOnly = process.argv.includes('--check');
const errors = [];
const paths = [
  'package.json', 'plugin/plugin.json', 'plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json',
  'plugin/.zcode-plugin/plugin.json', 'plugin/.mcp.json', '.agents/plugins/marketplace.json',
  'marketplace.json', '.cursor-plugin/marketplace.json',
];
const docs = Object.fromEntries(paths.map(path => {
  try { return [path, JSON.parse(readFileSync(rel(path), 'utf8'))]; }
  catch (err) { errors.push(`${path}: ${err.message}`); return [path, undefined]; }
}));
function failIfErrors() {
  if (!errors.length) return;
  console.error(`✗ plugin ${checkOnly ? 'check' : 'sync'} 失败：\n${errors.join('\n')}`);
  process.exit(1);
}
failIfErrors();

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
      sensitive: z.unknown().refine(v => v !== true, '敏感项必须走宿主环境变量'),
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
// 只用 schema 验证，保留原文档的未知字段，避免同步时丢失宿主元数据。
for (const [path, schema] of Object.entries(schemas)) {
  const result = schema.safeParse(docs[path]);
  if (!result.success) {
    for (const issue of result.error.issues) errors.push(`${path}:${issue.path.join('.')}: ${issue.message}`);
  }
}
failIfErrors();

const agentManifest = docs['plugin/plugin.json'];
const agentMcp = docs['plugin/mcp.json'];
const cursorManifest = docs['plugin/.cursor-plugin/plugin.json'];
const zcodeManifest = docs['plugin/.zcode-plugin/plugin.json'];
const zcodeMcp = docs['plugin/.mcp.json'];
const zcodeMarket = docs['marketplace.json'];
const serverOf = doc => doc.mcpServers['search-failover'];

// 占位符展开规则由各宿主分别约束，不能共用一种 env 模板。
for (const [key, value] of Object.entries(serverOf(agentMcp).env ?? {})) {
  if (value.includes('${') || ['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key)) {
    errors.push(`plugin/mcp.json: env.${key} 禁止占位符或保留变量`);
  }
}
for (const value of Object.values(serverOf(cursorManifest).env ?? {})) {
  for (const [, key] of value.matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) {
    if (!Object.hasOwn(cursorManifest.variables.properties, key)) {
      errors.push(`plugin/.cursor-plugin/plugin.json: env 引用的 ${key} 未在 variables.properties 声明`);
    }
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

const version = docs['package.json'].version;
const manifests = [agentManifest, cursorManifest, zcodeManifest, zcodeMarket.plugins[0]];
const servers = [agentMcp, cursorManifest, zcodeMcp].map(serverOf);
if (!checkOnly) {
  for (const doc of manifests) doc.version = version;
  for (const entry of servers) entry.args[1] = `search-failover@${version}`;
}
for (const path of ['plugin/plugin.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.zcode-plugin/plugin.json', 'marketplace.json']) {
  const actual = path === 'marketplace.json' ? zcodeMarket.plugins[0].version : docs[path].version;
  if (actual !== version) errors.push(`${path}: version 必须与 package.json 的 ${version} 一致`);
}
for (const path of ['plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.mcp.json']) {
  if (serverOf(docs[path]).args[1] !== `search-failover@${version}`) errors.push(`${path}: npx 锁定版本必须为 ${version}`);
}
failIfErrors();
if (!checkOnly) {
  for (const path of ['plugin/plugin.json', 'plugin/mcp.json', 'plugin/.cursor-plugin/plugin.json', 'plugin/.zcode-plugin/plugin.json', 'plugin/.mcp.json', 'marketplace.json']) {
    writeFileSync(rel(path), `${JSON.stringify(docs[path], null, 2)}\n`);
  }
}
console.log(`✓ plugin ${checkOnly ? 'check' : 'sync'} 通过：manifest×3 + 市场清单×3 + SKILL.md，版本统一为 ${version}`);
