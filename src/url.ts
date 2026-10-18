/** URL 规范化（仅作 dedupe key，返回给模型的仍是原 URL） */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', 'ref', 'ref_src', 'spm', 'from', 'vd_source',
]);

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    const kept = [...u.searchParams.entries()].filter(([k]) => !k.startsWith('utm_') && !TRACKING_PARAMS.has(k));
    u.search = '';
    for (const [k, v] of kept) u.searchParams.append(k, v);
    let s = u.toString();
    if (u.pathname === '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

/**
 * 把模型常传的写法归一成主机名：`https://docs.rs/tokio`、`site:docs.rs`、`*.docs.rs`、`docs.rs:443` → `docs.rs`。
 * 中文域名转成 punycode。无法识别时返回 undefined。
 */
export function normalizeDomain(raw: string): string | undefined {
  let value = raw.trim().toLowerCase().replace(/^site:/, '').replace(/^\*\./, '');
  if (!value) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `http://${value}`;
  try {
    const host = new URL(value).hostname.replace(/\.$/, '');
    return host.length <= 253 && HOSTNAME.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}
