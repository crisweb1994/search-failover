import { readEnv, type Env } from './env.js';

/**
 * 出站 HTTP。Node 自带的全局 fetch 不读 HTTPS_PROXY / HTTP_PROXY（Node 22.19 实测直连），
 * 配了代理时改用 undici 自己的 fetch + EnvHttpProxyAgent，两者版本一致，不依赖 Node 内置 undici 的版本。
 * 没配代理时仍走全局 fetch（测试里的 msw 拦截的也是它）。
 */
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

let proxiedFetch: FetchFn | undefined;

export interface NetworkInfo {
  /** 生效的代理地址（已隐去账号密码）；没有则 undefined */
  proxy?: string;
  /** 代理配置无法使用时的说明；此时直连，不让进程启动失败 */
  error?: string;
}

/** 和 curl 一样，没写协议的代理地址按 http:// 处理（`127.0.0.1:7890` 是常见写法） */
function withScheme(value: string | undefined): string | undefined {
  return value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? `http://${value}` : value;
}

export function proxySettings(env: Env = process.env) {
  const httpsProxy = withScheme(readEnv('HTTPS_PROXY', env) ?? readEnv('https_proxy', env));
  const httpProxy = withScheme(readEnv('HTTP_PROXY', env) ?? readEnv('http_proxy', env));
  // 本机地址（自建 SearXNG 常见）默认不走代理；用户自己设了 NO_PROXY 则以用户为准
  const noProxy = readEnv('NO_PROXY', env) ?? readEnv('no_proxy', env) ?? 'localhost,127.0.0.1,::1';
  return { httpsProxy, httpProxy, noProxy };
}

export async function initNetwork(env: Env = process.env): Promise<NetworkInfo> {
  const { httpsProxy, httpProxy, noProxy } = proxySettings(env);
  if (!httpsProxy && !httpProxy) {
    proxiedFetch = undefined;
    return {};
  }
  const shown = redactUrl(httpsProxy ?? httpProxy!);
  const unsupported = [httpsProxy, httpProxy].find(v => v && !/^https?:\/\//i.test(v));
  proxiedFetch = undefined;
  if (unsupported) return { error: `unsupported proxy ${redactUrl(unsupported)} (only http:// and https:// proxies are supported); connecting directly` };
  try {
    const { EnvHttpProxyAgent, fetch } = await import('undici');
    // 显式传值（空串 = 不设）：否则 undici 会回头读原始环境变量，未展开的模板会让它构造失败。
    // https 没单独配代理时，undici 自己会退回 http 代理。
    const dispatcher = new EnvHttpProxyAgent({ httpProxy: httpProxy ?? '', httpsProxy: httpsProxy ?? '', noProxy });
    proxiedFetch = (url, init) => fetch(url, { ...init, dispatcher } as never) as unknown as Promise<Response>;
    return { proxy: shown };
  } catch (err) {
    return { error: `invalid proxy ${shown}: ${err instanceof Error ? err.message : String(err)}; connecting directly` };
  }
}

export function httpFetch(url: string, init: RequestInit): Promise<Response> {
  return proxiedFetch ? proxiedFetch(url, init) : fetch(url, init);
}

export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '***';
      u.password = '';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return '(invalid proxy url)';
  }
}
