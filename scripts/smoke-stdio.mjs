#!/usr/bin/env node
/**
 * smoke-stdio.mjs — 发布冒烟：按插件 manifest 同款命令拉起真实分发包，跑完整 MCP 握手。
 *
 * 验证内容（对应插件验收清单）：
 *   ① stdout 每行均为合法 JSON-RPC（协议纯净性）
 *   ② initialize → notifications/initialized → tools/list → tools/call status → tools/call search
 *   ③ 零 key 环境：DDG active、其余源 unconfigured
 *   ④ 真实搜索一条（DuckDuckGo 兜底）并输出 fallback_chain
 *
 * 用法：
 *   node scripts/smoke-stdio.mjs                        # 零 key，npx -y search-failover@<package.json 版本>
 *   node scripts/smoke-stdio.mjs --command node -- dist/index.js   # 本地构建
 *   node scripts/smoke-stdio.mjs --env TAVILY_API_KEY=xxx          # 追加环境变量（其余 key 仍清空）
 *   node scripts/smoke-stdio.mjs --config /abs/path/search-failover.json
 *
 * 退出码：0 全过；1 断言失败（协议/状态）；2 协议全过但真实搜索为空（上游问题，看输出的链）。
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const parseFlag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv.splice(i, 2)[1];
};

const configPath = parseFlag('--config');
let extraEnv = {};
for (let i = argv.indexOf('--env'); i !== -1; i = argv.indexOf('--env')) {
  const kv = argv.splice(i, 2)[1];
  const eq = kv.indexOf('=');
  extraEnv[kv.slice(0, eq)] = kv.slice(eq + 1);
}
let command = ['npx', '-y', `search-failover@${pkg.version}`];
const cmdIdx = argv.indexOf('--command');
if (cmdIdx !== -1) {
  argv.splice(cmdIdx, 1);
  const sep = argv.indexOf('--');
  command = sep === -1 ? argv.splice(0) : [...argv.splice(0, sep), ...argv.splice(argv.indexOf('--') + 1)];
}

const KEY_NAMES = ['BOCHA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'EXA_API_KEY', 'ZHIPU_API_KEY', 'QIANFAN_API_KEY', 'SERPER_API_KEY'];
// 零 key 基线：清空全部 provider key，再叠加 --env / --config
const childEnv = { ...process.env };
for (const k of KEY_NAMES) childEnv[k] = '';
childEnv.LOG = 'error';
if (configPath) childEnv.SEARCH_FAILOVER_CONFIG = resolve(configPath);
childEnv.NODE_ENV = childEnv.NODE_ENV ?? 'production';
Object.assign(childEnv, extraEnv);

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// cwd 用中性临时目录：在仓库根下跑会命中 Volta 的"项目本地 bin"解析
// （本仓库自身就叫 search-failover，node_modules/.bin 里却没有它 → sh: command not found）；
// 宿主实际也只在自身 cwd / 插件缓存目录下拉起本包，不会在本仓库根。
const child = spawn(command[0], command.slice(1), { cwd: tmpdir(), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
const messages = [];
const stderrChunks = [];
let stdoutDirty = false;
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      stdoutDirty = true; // stdout 出现非 JSON-RPC 行 = 协议纯净性破坏
      console.error(`  stdout 非协议行: ${line.slice(0, 200)}`);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrChunks.push(c));

const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
const waitFor = async (id, what, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((m) => m.id === id && (m.result !== undefined || m.error !== undefined));
    if (found) {
      if (found.error) fail(`${what} 返回错误: ${JSON.stringify(found.error)}`);
      return found;
    }
    if (child.exitCode !== null) fail(`${what}: 进程提前退出（exit ${child.exitCode}）。stderr: ${stderrChunks.join('').slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`${what} 超时。stderr: ${stderrChunks.join('').slice(0, 2000)}`);
};

const startedAt = Date.now();
console.log(`▶ 拉起: ${command.join(' ')}（${configPath ? `config=${childEnv.SEARCH_FAILOVER_CONFIG}，` : ''}extra env keys: ${Object.keys(extraEnv).join(',') || '无'}）`);

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke-stdio', version: '0' } } });
  const init = await waitFor(1, 'initialize', 90000); // npx 首跑要下载包
  const serverName = init.result.serverInfo?.name;
  if (serverName !== 'search-failover') fail(`serverInfo.name 应为 search-failover，实际 ${JSON.stringify(serverName)}`);
  console.log(`✓ initialize（serverInfo ${serverName}@${init.result.serverInfo?.version}，${((Date.now() - startedAt) / 1000).toFixed(1)}s）`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await waitFor(2, 'tools/list');
  const names = tools.result.tools.map((t) => t.name);
  for (const expect of ['search', 'status']) {
    if (!names.includes(expect)) fail(`tools/list 缺少 ${expect}（实际: ${names.join(',')}）`);
  }
  console.log(`✓ notifications/initialized + tools/list（${names.join(' / ')}）`);

  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
  const status = await waitFor(3, 'tools/call status');
  const payload = JSON.parse(status.result.content[0].text);
  const byName = Object.fromEntries(payload.providers.map((p) => [p.name, p.state]));
  console.log(`✓ status：${payload.providers.map((p) => `${p.name}=${p.state}`).join(', ')}`);
  if (!extraEnv['TAVILY_API_KEY'] && !extraEnv['BOCHA_API_KEY'] && !extraEnv['BRAVE_API_KEY'] && !extraEnv['EXA_API_KEY'] && !extraEnv['ZHIPU_API_KEY'] && !extraEnv['QIANFAN_API_KEY'] && !extraEnv['SERPER_API_KEY']) {
    if (byName['duckduckgo'] !== 'active') fail(`零 key 环境下 duckduckgo 应为 active，实际 ${byName['duckduckgo']}`);
    if (byName['bocha'] !== 'unconfigured') fail(`零 key 环境下 bocha 应为 unconfigured，实际 ${byName['bocha']}`);
  }

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'model context protocol', max_results: 3, use_cache: false } } });
  const search = await waitFor(4, 'tools/call search', 60000);
  const result = JSON.parse(search.result.content[0].text);
  const chain = (result.meta?.fallback_chain ?? []).map((s) => `${s.provider}:${s.outcome}`).join(' → ');
  console.log(`✓ search：provider_used=${result.meta?.provider_used}，${result.results.length} 条结果`);
  console.log(`  fallback_chain: ${chain || '(空)'}`);
  if (result.results.length === 0) {
    console.error(`⚠ 全链无结果——协议全过，但真实搜索为空（退出码 2）。链：${chain}`);
    process.exit(2);
  }
  if (!result.results.every((r) => r.title && r.url && r.snippet !== undefined)) fail('results 条目缺少必有字段 title/url/snippet');
  if (stdoutDirty) fail('stdout 混入非 JSON-RPC 行');
  console.log('✓ 全握手冒烟通过：initialize → initialized → tools/list → status → 真实搜索');
} finally {
  child.kill();
  await new Promise((r) => child.on('exit', r));
}
