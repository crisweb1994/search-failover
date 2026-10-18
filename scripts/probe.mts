/**
 * live probe：接入或校准来源前，用真实凭据探明响应结构与错误体，
 * 输出脱敏快照到 test/fixtures/<provider>.probe.json，作为契约 fixture 的事实来源。
 *
 * 每个来源发四种请求：normal（正常查询）、no_results（必然无结果的查询，确认空结果长什么样）、
 * bad_key（错误凭据）、overflow（参数越界）。
 *
 * 用法：npx tsx scripts/probe.mts <provider> [--no-bad-key]
 * CI 不跑；需要对应环境变量里存在真实凭据（SearXNG 是 SEARXNG_URL）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

type Variant = 'normal' | 'no_results' | 'bad_key' | 'overflow';
type Request = { url: string; init: RequestInit };

const QUERY = 'search-failover probe';
/** 几乎不可能命中任何网页的查询 */
const NONSENSE = 'zxqvbnmpoiu 7f3a9c2e1d qwlkjhgfdsa';

const json = (key: string, scheme: 'bearer' | 'x-api-key', body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { ...(scheme === 'bearer' ? { Authorization: `Bearer ${key}` } : { 'X-API-KEY': key }), 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const query = (variant: Variant) => (variant === 'no_results' ? NONSENSE : QUERY);

const PROBES: Record<string, { env: string; badKey?: boolean; request: (credential: string, variant: Variant) => Request }> = {
  bocha: {
    env: 'BOCHA_API_KEY',
    request: (key, v) => ({
      url: 'https://api.bochaai.com/v1/web-search',
      init: json(key, 'bearer', { query: query(v), count: v === 'overflow' ? 999 : 8, summary: true }),
    }),
  },
  zhipu: {
    env: 'ZHIPU_API_KEY',
    request: (key, v) => ({
      url: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      init: json(key, 'bearer', { search_query: query(v), search_engine: 'search_std', count: v === 'overflow' ? 999 : 8, search_intent: false, content_size: 'medium' }),
    }),
  },
  deepseek: {
    env: 'DEEPSEEK_API_KEY',
    request: (key, v) => ({
      url: 'https://api.deepseek.com/v1/tools/search',
      init: json(key, 'bearer', { query: query(v), count: v === 'overflow' ? 999 : 8 }),
    }),
  },
  tavily: {
    env: 'TAVILY_API_KEY',
    request: (key, v) => ({
      url: 'https://api.tavily.com/search',
      init: json(key, 'bearer', { query: query(v), max_results: v === 'overflow' ? 999 : 8, search_depth: 'basic', include_published_date: true }),
    }),
  },
  qianfan: {
    env: 'QIANFAN_API_KEY',
    request: (key, v) => ({
      url: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      init: json(key, 'bearer', {
        messages: [{ role: 'user', content: query(v) }],
        search_source: 'baidu_search_v2',
        resource_type_filter: [{ type: 'web', top_k: v === 'overflow' ? 9999 : 8 }],
      }),
    }),
  },
  brave: {
    env: 'BRAVE_API_KEY',
    request: (key, v) => ({
      url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query(v), count: v === 'overflow' ? '999' : '8' })}`,
      init: { method: 'GET', headers: { 'X-Subscription-Token': key, Accept: 'application/json' } },
    }),
  },
  serper: {
    env: 'SERPER_API_KEY',
    request: (key, v) => ({
      url: 'https://google.serper.dev/search',
      init: json(key, 'x-api-key', { q: query(v), num: v === 'overflow' ? 9999 : 8 }),
    }),
  },
  exa: {
    env: 'EXA_API_KEY',
    request: (key, v) => ({
      url: 'https://api.exa.ai/search',
      init: json(key, 'bearer', { query: query(v), numResults: v === 'overflow' ? 9999 : 8, type: 'fast', contents: { text: { maxCharacters: 2000 } } }),
    }),
  },
  searxng: {
    env: 'SEARXNG_URL',
    badKey: false, // 没有凭据可错；overflow 用超大页码
    request: (base, v) => ({
      url: `${base.replace(/\/$/, '')}/search?${new URLSearchParams({ q: query(v), format: 'json', ...(v === 'overflow' ? { pageno: '9999' } : {}) })}`,
      init: { method: 'GET', headers: { Accept: 'application/json' } },
    }),
  },
};

const name = process.argv[2] ?? '';
const probe = PROBES[name];
if (!probe) {
  console.error(`用法: npx tsx scripts/probe.mts <${Object.keys(PROBES).join('|')}> [--no-bad-key]`);
  process.exit(1);
}
const credential = process.env[probe.env]?.trim();
if (!credential) {
  console.error(`缺少环境变量 ${probe.env}——probe 需要真实凭据（不产生半截 fixture）`);
  process.exit(1);
}

const KEEP_HEADERS = [/ratelimit/i, /retry-after/i, /request-id/i];

/** 递归脱敏：凭据值替换、长文本截断 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '<max-depth>';
  if (typeof value === 'string') {
    if (value.includes(credential!) || /bearer|sk-|api[-_]?key/i.test(value)) return '<redacted>';
    return value.length > 200 ? `${value.slice(0, 200)}…(${value.length})` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 10).map(v => redact(v, depth + 1));
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

async function shoot(variant: Variant) {
  const { url, init } = probe!.request(variant === 'bad_key' ? 'invalid-probe-key' : credential!, variant);
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { if (KEEP_HEADERS.some(re => re.test(k))) headers[k] = v; });
    const text = await res.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 500); }
    return { variant, status: res.status, headers, body: redact(body) };
  } catch (e) {
    return { variant, transport_error: String(e instanceof Error ? e.message : e) };
  }
}

const variants: Variant[] = ['normal', 'no_results', 'overflow'];
if (probe.badKey !== false && !process.argv.includes('--no-bad-key')) variants.splice(2, 0, 'bad_key');
const results = [];
for (const variant of variants) results.push(await shoot(variant));

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${name}.probe.json`);
writeFileSync(file, `${JSON.stringify({ meta: { provider: name, date: new Date().toISOString(), note: 'live probe 脱敏快照；契约 fixture 以此为准' }, results }, null, 2)}\n`);
console.log(`已写入 ${file}`);
for (const r of results) console.log(`  [${r.variant}] status=${'status' in r ? r.status : '-'} ${'transport_error' in r ? r.transport_error : ''}`);
