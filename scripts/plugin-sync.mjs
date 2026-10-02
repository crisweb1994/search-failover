#!/usr/bin/env node
/**
 * plugin-sync.mjs — 插件清单版本同步 + 结构级校验（零依赖）。
 *
 * 用法：
 *   node scripts/plugin-sync.mjs           # 把 package.json 版本同步进所有插件 manifest / 市场清单 / npx 锁定版本
 *   node scripts/plugin-sync.mjs --check   # 只做校验，不写文件（prepublishOnly / CI 用）
 *
 * 校验范围（写模式同步后同样执行）：
 *   plugin/plugin.json                     Agent Plugins 1.0 封闭 schema + name 规则
 *   plugin/mcp.json                        顶层白名单；stdio；command 单 token；env 禁止任何 ${ 占位符
 *   plugin/.cursor-plugin/plugin.json      variables 形状；内联 mcpServers；每个 ${VAR} 必须已声明
 *   plugin/.zcode-plugin/plugin.json       name 规则；mcpServers 指向的文件存在；userConfig 禁止 sensitive；
 *                                          被 .mcp.json 引用的 userConfig 键必须有 default（防占位符字面量进 env）
 *   plugin/.mcp.json                       env 值只允许 ${user_config.键} 引用
 *   .agents/plugins/marketplace.json       Codex：source.path ./ 相对仓库根且存在；policy/category 必填
 *   marketplace.json                       ZCode：source 解析存在；version 与 package.json 一致
 *   .cursor-plugin/marketplace.json        Cursor：owner；source 解析到含 .cursor-plugin/plugin.json 的目录
 *   plugin/skills/web-search/SKILL.md      存在且 frontmatter 含 name/description
 *   版本一致性                             package.json = 3 manifest = ZCode 市场条目 = 三处 npx 锁定版本
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const errors = [];

const rel = (p) => join(repoRoot, p);

function readJson(path) {
  const abs = rel(path);
  if (!existsSync(abs)) {
    errors.push(`缺少文件: ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    errors.push(`${path} 不是合法 JSON: ${err.message}`);
    return undefined;
  }
}

function writeJson(path, data) {
  writeFileSync(rel(path), `${JSON.stringify(data, null, 2)}\n`);
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** stdio 声明的公共校验；extraEnvCheck(env) 用于各宿主差异规则 */
function checkStdioServer(path, server, extraEnvCheck) {
  if (!isPlainObject(server)) {
    errors.push(`${path}: server 声明必须是对象`);
    return;
  }
  if (server.type !== 'stdio') {
    errors.push(`${path}: type 必须是 "stdio"（当前: ${JSON.stringify(server.type)}）`);
  }
  if (typeof server.command !== 'string' || server.command.length === 0 || /\s/.test(server.command)) {
    errors.push(`${path}: command 必须是无空白单 token 字符串`);
  }
  if (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string')) {
    errors.push(`${path}: args 必须是字符串数组`);
  }
  if (server.env !== undefined) {
    if (!isPlainObject(server.env)) {
      errors.push(`${path}: env 必须是对象`);
    } else {
      for (const [k, v] of Object.entries(server.env)) {
        if (typeof v !== 'string') {
          errors.push(`${path}: env.${k} 的值必须是字符串`);
        }
      }
      extraEnvCheck?.(server.env);
    }
  }
}

/** 校验 args 形如 ["-y", "search-failover@<version>"]，返回锁定版本号 */
function pinnedVersion(path, args) {
  if (Array.isArray(args) && args.length === 2 && args[0] === '-y' && args[1]?.startsWith('search-failover@')) {
    return args[1].slice('search-failover@'.length);
  }
  errors.push(`${path}: args 必须形如 ["-y", "search-failover@<version>"]`);
  return undefined;
}

function collectVars(env) {
  const found = new Set();
  for (const v of Object.values(env)) {
    for (const m of String(v).matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) found.add(m[1]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 读取所有清单
// ---------------------------------------------------------------------------

const pkg = readJson('package.json');
const agentManifest = readJson('plugin/plugin.json');
const agentMcp = readJson('plugin/mcp.json');
const cursorManifest = readJson('plugin/.cursor-plugin/plugin.json');
const zcodeManifest = readJson('plugin/.zcode-plugin/plugin.json');
const zcodeMcp = readJson('plugin/.mcp.json');
const codexMarket = readJson('.agents/plugins/marketplace.json');
const zcodeMarket = readJson('marketplace.json');
const cursorMarket = readJson('.cursor-plugin/marketplace.json');

const pkgVersion = pkg?.version;
if (typeof pkgVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(pkgVersion)) {
  errors.push('package.json: 缺少合法的 semver version');
}

// ---------------------------------------------------------------------------
// 写模式：同步版本
// ---------------------------------------------------------------------------

if (!checkOnly && pkgVersion && errors.length === 0) {
  if (agentManifest) agentManifest.version = pkgVersion;
  if (cursorManifest) {
    cursorManifest.version = pkgVersion;
    cursorManifest.mcpServers?.['search-failover']?.args?.splice(1, 1, `search-failover@${pkgVersion}`);
  }
  if (zcodeManifest) zcodeManifest.version = pkgVersion;
  for (const [path, doc] of [
    ['plugin/mcp.json', agentMcp],
    ['plugin/.mcp.json', zcodeMcp],
  ]) {
    const server = doc?.mcpServers?.['search-failover'];
    if (Array.isArray(server?.args) && server.args[0] === '-y') {
      server.args[1] = `search-failover@${pkgVersion}`;
    } else {
      errors.push(`${path}: 无法定位 npx 锁定版本进行同步`);
    }
  }
  if (zcodeMarket?.plugins?.[0]) zcodeMarket.plugins[0].version = pkgVersion;

  writeJson('plugin/plugin.json', agentManifest);
  writeJson('plugin/mcp.json', agentMcp);
  writeJson('plugin/.cursor-plugin/plugin.json', cursorManifest);
  writeJson('plugin/.zcode-plugin/plugin.json', zcodeManifest);
  writeJson('plugin/.mcp.json', zcodeMcp);
  writeJson('marketplace.json', zcodeMarket);
}

// ---------------------------------------------------------------------------
// 结构校验
// ---------------------------------------------------------------------------

// 1. Agent Plugins manifest（封闭 schema）
if (agentManifest) {
  const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
  for (const key of Object.keys(agentManifest)) {
    if (!allowed.has(key)) errors.push(`plugin/plugin.json: 顶层出现规范外字段 "${key}"`);
  }
  if (agentManifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
    errors.push('plugin/plugin.json: $schema 必须精确等于 Agent Plugins 1.0.0 的 schema URL');
  }
  if (agentManifest.name !== 'search-failover') {
    errors.push(`plugin/plugin.json: name 必须是 "search-failover"（当前: ${JSON.stringify(agentManifest.name)}）`);
  }
  if (!agentManifest.version || !agentManifest.description) {
    errors.push('plugin/plugin.json: version 与 description 为本项目必填');
  }
  if (agentManifest.extensions !== undefined && !isPlainObject(agentManifest.extensions)) {
    errors.push('plugin/plugin.json: extensions 必须是对象');
  }
}

// 2. Agent Plugins mcp.json（共享声明：env 禁止一切占位符，杜绝未展开字面量进入进程）
if (agentMcp) {
  for (const key of Object.keys(agentMcp)) {
    if (key !== '$schema' && key !== 'mcpServers') errors.push(`plugin/mcp.json: 顶层只允许 $schema/mcpServers（发现 "${key}"）`);
  }
  if (agentMcp.$schema !== 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json') {
    errors.push('plugin/mcp.json: $schema 必须精确等于 Agent Plugins 1.0.0 mcp schema URL');
  }
  const server = agentMcp.mcpServers?.['search-failover'];
  checkStdioServer('plugin/mcp.json', server, (env) => {
    for (const [k, v] of Object.entries(env)) {
      if (v.includes('${')) errors.push(`plugin/mcp.json: 共享声明的 env 禁止占位符（env.${k} 含 "\${"）`);
      if (k === 'PLUGIN_ROOT' || k === 'PLUGIN_DATA') errors.push(`plugin/mcp.json: env 禁止保留变量 ${k}`);
    }
  });
}
const agentPin = agentMcp ? pinnedVersion('plugin/mcp.json', agentMcp.mcpServers?.['search-failover']?.args) : undefined;

// 3. Cursor 原生清单（自包含：variables + 内联 mcpServers）
if (cursorManifest) {
  if (cursorManifest.name !== 'search-failover') errors.push(`plugin/.cursor-plugin/plugin.json: name 必须是 "search-failover"`);
  // Cursor 官方要求 variables 是完整 JSON Schema：顶层 {"type":"object","properties":{...}}
  if (!isPlainObject(cursorManifest.variables)) {
    errors.push('plugin/.cursor-plugin/plugin.json: 必须声明 variables（JSON Schema）');
  } else if (cursorManifest.variables.type !== 'object' || !isPlainObject(cursorManifest.variables.properties)) {
    errors.push('plugin/.cursor-plugin/plugin.json: variables 必须形如 {"type":"object","properties":{...}}（变量放进 properties，不是扁平字典）');
  } else {
    for (const [k, v] of Object.entries(cursorManifest.variables.properties)) {
      if (!isPlainObject(v) || typeof v.type !== 'string') {
        errors.push(`plugin/.cursor-plugin/plugin.json: variables.properties.${k} 必须是含 type 的对象`);
      }
    }
  }
  const server = cursorManifest.mcpServers?.['search-failover'];
  checkStdioServer('plugin/.cursor-plugin/plugin.json', server, (env) => {
    const declared = new Set(Object.keys(cursorManifest.variables?.properties ?? {}));
    for (const v of collectVars(env)) {
      if (!declared.has(v)) errors.push(`plugin/.cursor-plugin/plugin.json: env 引用了未在 variables.properties 声明的 \${${v}}`);
    }
  });
}
const cursorPin = cursorManifest
  ? pinnedVersion('plugin/.cursor-plugin/plugin.json', cursorManifest.mcpServers?.['search-failover']?.args)
  : undefined;

// 4. ZCode manifest
if (zcodeManifest) {
  if (zcodeManifest.name !== 'search-failover') errors.push(`plugin/.zcode-plugin/plugin.json: name 必须是 "search-failover"`);
  const mcpField = zcodeManifest.mcpServers;
  if (typeof mcpField === 'string') {
    const target = mcpField.replace(/^\.\//, '');
    if (!existsSync(rel(join('plugin', target)))) errors.push(`plugin/.zcode-plugin/plugin.json: mcpServers 指向的 ${mcpField} 不存在`);
  } else {
    errors.push('plugin/.zcode-plugin/plugin.json: mcpServers 必须指向文件（本项目约定 "./.mcp.json"）');
  }
  const userConfig = zcodeManifest.userConfig;
  if (!isPlainObject(userConfig)) {
    errors.push('plugin/.zcode-plugin/plugin.json: 必须声明 userConfig');
  } else {
    const allowedTypes = new Set(['string', 'number', 'boolean', 'directory', 'file']);
    for (const [k, v] of Object.entries(userConfig)) {
      if (!isPlainObject(v) || !allowedTypes.has(v.type)) {
        errors.push(`plugin/.zcode-plugin/plugin.json: userConfig.${k} 类型必须是 ${[...allowedTypes].join('/')}`);
      }
      if (v.sensitive === true) {
        errors.push(`plugin/.zcode-plugin/plugin.json: userConfig.${k} 标记了 sensitive——ZCode 当前不支持界面填写敏感项，密钥一律走宿主环境变量（v1 约束）`);
      }
    }
  }
}

// 5. ZCode .mcp.json（env 只允许 ${user_config.键}，且键已声明、带 default）
if (zcodeMcp) {
  const server = zcodeMcp.mcpServers?.['search-failover'];
  const userConfig = zcodeManifest?.userConfig ?? {};
  checkStdioServer('plugin/.mcp.json', server, (env) => {
    for (const [k, v] of Object.entries(env)) {
      const m = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/.exec(v);
      if (!m) {
        errors.push(`plugin/.mcp.json: env.${k} 只允许 "${'${user_config.键}'}" 形式的引用（当前: ${JSON.stringify(v)}）`);
        continue;
      }
      const key = m[1];
      if (!(key in userConfig)) errors.push(`plugin/.mcp.json: env.${k} 引用的 userConfig.${key} 未声明`);
      else if (!('default' in userConfig[key])) {
        errors.push(`plugin/.mcp.json: env.${k} 引用的 userConfig.${key} 必须带 default（未填写时按 default 展开，防占位符字面量进入进程）`);
      }
    }
  });
}
const zcodePin = zcodeMcp ? pinnedVersion('plugin/.mcp.json', zcodeMcp.mcpServers?.['search-failover']?.args) : undefined;

// 6. Codex 市场（.agents/plugins/marketplace.json）
if (codexMarket) {
  if (!codexMarket.name) errors.push('.agents/plugins/marketplace.json: 缺少 name');
  const entry = codexMarket.plugins?.[0];
  if (!entry?.name) errors.push('.agents/plugins/marketplace.json: plugins[0].name 必填');
  const src = entry?.source;
  if (!isPlainObject(src) || src.source !== 'local' || typeof src.path !== 'string' || !src.path.startsWith('./')) {
    errors.push('.agents/plugins/marketplace.json: source 必须是 { source: "local", path: "./..." }（自引用 git-subdir 有 ref 一致性与未提交改动问题，不用）');
  } else if (!statSync(rel(src.path)).isDirectory()) {
    errors.push(`.agents/plugins/marketplace.json: source.path ${src.path} 不是目录`);
  }
  const policy = entry?.policy ?? {};
  const installations = new Set(['AVAILABLE', 'INSTALLED_BY_DEFAULT', 'NOT_AVAILABLE']);
  if (!installations.has(policy.installation)) errors.push('.agents/plugins/marketplace.json: policy.installation 必须是 AVAILABLE/INSTALLED_BY_DEFAULT/NOT_AVAILABLE');
  if (!policy.authentication) errors.push('.agents/plugins/marketplace.json: policy.authentication 必填');
  if (!entry?.category) errors.push('.agents/plugins/marketplace.json: category 必填');
}

// 7. ZCode 市场（根 marketplace.json）
if (zcodeMarket) {
  if (!zcodeMarket.name) errors.push('marketplace.json: 缺少 name');
  const entry = zcodeMarket.plugins?.[0];
  if (!entry?.name) errors.push('marketplace.json: plugins[0].name 必填');
  if (typeof entry?.source === 'string' && entry.source.startsWith('./')) {
    if (!statSync(rel(entry.source)).isDirectory()) errors.push(`marketplace.json: source ${entry.source} 不是目录`);
  } else {
    errors.push('marketplace.json: plugins[0].source 必须是 "./..." 目录路径');
  }
}

// 8. Cursor 市场（.cursor-plugin/marketplace.json）
if (cursorMarket) {
  if (!cursorMarket.name) errors.push('.cursor-plugin/marketplace.json: 缺少 name');
  if (!cursorMarket.owner?.name) errors.push('.cursor-plugin/marketplace.json: owner.name 必填');
  const entry = cursorMarket.plugins?.[0];
  if (!entry?.name) errors.push('.cursor-plugin/marketplace.json: plugins[0].name 必填');
  if (typeof entry?.source === 'string' && !entry.source.startsWith('.')) {
    const dir = rel(entry.source);
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, '.cursor-plugin', 'plugin.json'))) {
      errors.push(`.cursor-plugin/marketplace.json: source ${entry.source} 必须解析到含 .cursor-plugin/plugin.json 的目录`);
    }
  } else {
    errors.push('.cursor-plugin/marketplace.json: plugins[0].source 必须是目录名');
  }
}

// 9. SKILL.md 存在 + frontmatter
{
  const skillPath = rel('plugin/skills/web-search/SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push('plugin/skills/web-search/SKILL.md 不存在');
  } else {
    const text = readFileSync(skillPath, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!fm) {
      errors.push('plugin/skills/web-search/SKILL.md: 缺少 frontmatter');
    } else {
      if (!/^name:\s*\S+/m.test(fm[1])) errors.push('plugin/skills/web-search/SKILL.md: frontmatter 缺少 name');
      if (!/^description:\s*\S+/m.test(fm[1])) errors.push('plugin/skills/web-search/SKILL.md: frontmatter 缺少 description');
    }
  }
}

// 10. 版本一致性
if (pkgVersion) {
  const versions = {
    'package.json': pkgVersion,
    ...(agentManifest?.version ? { 'plugin/plugin.json': agentManifest.version } : {}),
    ...(cursorManifest?.version ? { 'plugin/.cursor-plugin/plugin.json': cursorManifest.version } : {}),
    ...(zcodeManifest?.version ? { 'plugin/.zcode-plugin/plugin.json': zcodeManifest.version } : {}),
    ...(zcodeMarket?.plugins?.[0]?.version ? { 'marketplace.json(ZCode 条目)': zcodeMarket.plugins[0].version } : {}),
    ...(agentPin ? { 'plugin/mcp.json npx 锁定': agentPin } : {}),
    ...(cursorPin ? { 'plugin/.cursor-plugin npx 锁定': cursorPin } : {}),
    ...(zcodePin ? { 'plugin/.mcp.json npx 锁定': zcodePin } : {}),
  };
  const mismatched = Object.entries(versions).filter(([, v]) => v !== pkgVersion);
  for (const [where, v] of mismatched) errors.push(`${where}: 版本 ${v} 与 package.json 的 ${pkgVersion} 不一致`);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  console.error(`✗ plugin ${checkOnly ? 'check' : 'sync'} 失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`✓ plugin ${checkOnly ? 'check' : 'sync'} 通过：manifest×3 + 市场清单×3 + SKILL.md，版本统一为 ${pkgVersion}`);
