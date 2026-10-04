import { parseDocument, DomUtils } from 'htmlparser2';
import { ProviderError, type RawResult, type SearchRequest } from '../types.js';
import { normalizeUrl } from '../router.js';
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

    return parseHtml(res.bodyText, fetchCount);
  },
};

const hasClass = (el: { attribs: Record<string, string> }, name: string) =>
  (el.attribs['class'] ?? '').split(/\s+/).includes(name);

export function parseHtml(html: string, max: number): RawResult[] {
  const doc = parseDocument(html);
  const containers = DomUtils.findAll(el => hasClass(el, 'result'), doc.children);
  const seen = new Set<string>();
  const out: RawResult[] = [];
  let recognized = false;
  for (const container of containers) {
    if (hasClass(container, 'result--ad')) continue;
    const anchor = DomUtils.findOne(el => hasClass(el, 'result__a'), container.children);
    if (!anchor) continue;
    const url = unwrapUddg(anchor.attribs['href'] ?? '');
    if (!url) continue;
    recognized = true;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = DomUtils.findOne(el => hasClass(el, 'result__snippet'), container.children);
    const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
    out.push({ title: clean(DomUtils.textContent(anchor)), url,
      snippet: snippet ? clean(DomUtils.textContent(snippet)) || undefined : undefined });
    if (out.length >= max) break;
  }
  if (!recognized) {
    if (DomUtils.findOne(el => hasClass(el, 'no-results') || hasClass(el, 'no-results__message'), doc.children)) return [];
    if (/anomaly-modal|anomaly\.js|id=["'](?:challenge|anomaly)-form|please complete the CAPTCHA/i.test(html)) {
      throw new ProviderError('duckduckgo', 'rate_limited', 'ddg_challenge_page', { retryAfterMs: CHALLENGE_COOLDOWN_MS });
    }
    throw new ProviderError('duckduckgo', 'server_error', 'invalid_response');
  }
  return out;
}

/** DDG 把真实 URL 包在 //duckduckgo.com/l/?uddg=<enc> 重定向里，解包 */
function unwrapUddg(href: string): string | undefined {
  try {
    let raw = href.trim();
    if (raw.startsWith('/')) raw = new URL(raw, ENDPOINT).href;
    if (!/^https?:\/\//i.test(raw)) return undefined;
    let u = new URL(raw);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.searchParams.has('uddg')) {
      u = new URL(u.searchParams.get('uddg') ?? '');
    }
    if (!['http:', 'https:'].includes(u.protocol)) return undefined;
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && /^\/(?:y\.js|aclick)(?:[/?]|$)/i.test(u.pathname)) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}
