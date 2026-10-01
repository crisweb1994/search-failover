/**
 * live probe（D16）：接入新源前用真实 key 探明响应结构与错误体，
 * 输出脱敏快照到 test/fixtures/<provider>.probe.json，作为契约 fixture 的事实来源。
 *
 * 用法：npx tsx scripts/probe.mts zhipu|qianfan|serper [--no-bad-key]
 * CI 不跑；需要对应环境变量里存在真实 key。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

type Probe = {
  env: string;
  endpoint: string;
  method: string;
  headers: (key: string) => Record<string, string>;
  /** 正常请求体（probe 会另发 bad-key 与越界两个变体） */
  body: Record<string, unknown>;
  /** 越界变体：把参数推到非法区间探参数错误路径 */
  overflow: (body: Record<string, unknown>) => Record<string, unknown>;
};

const PROBES: Record<string, Probe> = {
  zhipu: {
    env: 'ZHIPU_API_KEY',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
    method: 'POST',
    headers: k => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: { search_query: 'search-failover probe', search_engine: 'search_std', count: 8, search_intent: false, content_size: 'medium' },
    overflow: b => ({ ...b, count: 999 }),
  },
  qianfan: {
    env: 'QIANFAN_API_KEY',
    endpoint: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
    method: 'POST',
    headers: k => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }),
    body: {
      messages: [{ role: 'user', content: 'search-failover probe' }],
      search_source: 'baidu_search_v2',
      resource_type_filter: { web: { top_k: 8 } },
    },
    overflow: b => ({ ...b, resource_type_filter: { web: { top_k: 9999 } } }),
  },
  serper: {
    env: 'SERPER_API_KEY',
    endpoint: 'https://google.serper.dev/search',
    method: 'POST',
    headers: k => ({ 'X-API-KEY': k, 'Content-Type': 'application/json' }),
    body: { q: 'search-failover probe', num: 8 },
    overflow: b => ({ ...b, num: 9999 }),
  },
};

const name = process.argv[2];
const noBadKey = process.argv.includes('--no-bad-key');
const probe = PROBES[name];
if (!name || !probe) {
  console.error(`用法: npx tsx scripts/probe.mts <${Object.keys(PROBES).join('|')}> [--no-bad-key]`);
  process.exit(1);
}
const key = process.env[probe.env];
if (!key) {
  console.error(`缺少环境变量 ${probe.env}——probe 需要真实 key（不产生半截 fixture）`);
  process.exit(1);
}

const KEEP_HEADERS = [/ratelimit/i, /retry-after/i, /request-id/i];

/** 递归脱敏：凭据值替换、长文本截断 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<max-depth>';
  if (typeof value === 'string') {
    if (/bearer|sk-|api[-_]?key/i.test(value)) return '<redacted>';
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length})` : value;
  }
  if (Array.isArray(value)) return value.length > 10 ? value.slice(0, 10).map(v => redact(v, depth + 1)) : value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/authorization|token|secret|password/i.test(k)) out[k] = '<redacted>';
      else if (/content|summary|text|snippet/i.test(k) && typeof v === 'string') out[k] = `${v.slice(0, 200)}…(${v.length})`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function shoot(label: string, headers: Record<string, string>, body: Record<string, unknown>) {
  try {
    const res = await fetch(probe.endpoint, {
      method: probe.method,
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const headersOut: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (KEEP_HEADERS.some(re => re.test(k))) headersOut[k] = v; });
    let parsed: unknown;
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 500); }
    return { label, status: res.status, headers: headersOut, body: redact(parsed) };
  } catch (e) {
    return { label, transport_error: String(e instanceof Error ? e.message : e) };
  }
}

const results = [
  await shoot('normal', probe.headers(key), probe.body),
  ...(noBadKey ? [] : [await shoot('bad_key', probe.headers('invalid-probe-key'), probe.body)]),
  await shoot('overflow', probe.headers(key), probe.overflow(probe.body)),
];

const fixture = {
  meta: { provider: name, endpoint: probe.endpoint, date: new Date().toISOString(), note: 'D16 live probe 脱敏快照；契约 fixture 以此为准' },
  results,
};

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}.probe.json`);
writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`已写入 ${file}`);
for (const r of results) console.log(`  [${r['label']}] status=${r['status'] ?? '-'} ${r['transport_error'] ?? ''}`);
