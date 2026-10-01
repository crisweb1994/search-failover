import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import { normalizeUrl } from '../router.js';
import { log } from '../logger.js';
import { classifyDefault, FRESHNESS, rawRequest, type ProviderAdapter } from './types.js';

const ENDPOINT = 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHALLENGE_COOLDOWN_MS = 6 * 3600 * 1000; // 被封走该源 cooldown_max_s=6h 覆盖（配置默认值）

/**
 * DuckDuckGo HTML 端点（无 key 兜底）。关键陷阱：限流不是 429 而是 HTTP 202+异常页，
 * 封禁是 403/challenge 页。challenge 判定必须是复合条件（解析出 0 条 且 含关键词）：
 * bodyText 含结果标题/摘要，单凭关键词会把搜 "challenge/captcha" 本身的正常结果页
 * 误判为封禁页，导致 DDG 被屏蔽 6 小时。
 */
export const duckduckgo: ProviderAdapter = {
  name: 'duckduckgo',
  maxCount: 20,
  note(req: SearchRequest): string | undefined {
    return req.includeDomains?.length ? 'duckduckgo: include_domains 不支持，已忽略' : undefined;
  },
  async search(req, fetchCount, signal) {
    const params = new URLSearchParams({ q: req.query });
    if (req.freshness) params.set('df', FRESHNESS.ddg[req.freshness]);

    const res = await rawRequest(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'text/html',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      body: params.toString(),
    }, 'duckduckgo', signal);

    if (res.status === 202) throw new ProviderError('duckduckgo', 'rate_limited', 'http_202_anomaly');
    if (res.status === 403) throw new ProviderError('duckduckgo', 'rate_limited', 'ddg_challenge_403', { retryAfterMs: CHALLENGE_COOLDOWN_MS });
    if (res.status !== 200) throw classifyDefault(res, 'duckduckgo');

    const results = parseHtml(res.bodyText, fetchCount);
    if (results.length === 0 && /anomaly|challenge|captcha|blocked/i.test(res.bodyText)) {
      throw new ProviderError('duckduckgo', 'rate_limited', 'ddg_challenge_page', { retryAfterMs: CHALLENGE_COOLDOWN_MS });
    }
    if (results.length === 0 && res.bodyText.length > 1024) {
      log.warn(`duckduckgo: 响应 ${res.bodyText.length} 字符但解析出 0 条结果，疑似页面结构变更（result__a 选择器失效）`);
    }
    return results;
  },
};

const ANCHOR_RE = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
const SNIPPET_RE = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

export function parseHtml(html: string, max: number): RawResult[] {
  const titles: { href: string; title: string }[] = [];
  for (const m of html.matchAll(ANCHOR_RE)) {
    titles.push({ href: m[1] ?? '', title: decodeEntities(stripTags(m[2] ?? '')) });
  }
  const snippets: string[] = [];
  for (const m of html.matchAll(SNIPPET_RE)) {
    snippets.push(decodeEntities(stripTags(m[1] ?? '')));
  }

  const seen = new Set<string>();
  const out: RawResult[] = [];
  for (let i = 0; i < titles.length && out.length < max; i++) {
    const url = unwrapUddg(titles[i]!.href);
    if (!url) continue;
    const key = normalizeUrl(url); // 剥追踪参数后去重（utm 变体视为同一条）
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: titles[i]!.title, url, snippet: snippets[i] || undefined });
  }
  return out;
}

/** DDG 把真实 URL 包在 //duckduckgo.com/l/?uddg=<enc> 重定向里，解包 */
function unwrapUddg(href: string): string | undefined {
  let raw = href.trim();
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.searchParams.has('uddg')) {
      const target = u.searchParams.get('uddg') ?? '';
      return /^https?:\/\//i.test(target) ? target : undefined;
    }
    return u.toString();
  } catch {
    return undefined;
  }
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ',
};
export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|x27|nbsp|#39);/g, m => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}
