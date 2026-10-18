import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { httpFetch, initNetwork, proxySettings, redactUrl } from '../../src/net.js';
import { rawRequest } from '../../src/providers/types.js';

/**
 * 本地 CONNECT 代理：记录隧道请求，并把所有隧道都接到本地目标服务器（真实来源都是 HTTPS，走的就是 CONNECT）。
 * 目标服务器回显收到的 Host 头：经代理时是原始主机名，直连时是 127.0.0.1。
 */
const seen: string[] = [];
const sockets = new Set<Socket>();
let proxy: Server;
let target: Server;
const port = (s: Server) => (s.address() as AddressInfo).port;

async function listen(server: Server): Promise<Server> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

beforeAll(async () => {
  target = await listen(createServer((req, res) => res.end(`host=${req.headers.host}`)));
  proxy = await listen(createServer((_req, res) => res.writeHead(400).end()));
  proxy.on('connect', (req, client: Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`);
    const upstream = connect(port(target), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client).pipe(upstream);
    });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => {}); }
  });
});
beforeEach(() => { seen.length = 0; });
afterAll(async () => {
  await initNetwork({});
  for (const socket of sockets) socket.destroy();
  proxy.close();
  target.close();
});

describe('出站代理', () => {
  it('配了 HTTP_PROXY 时请求走代理（Node 全局 fetch 自己不读这个变量）；status 里隐去账号密码', async () => {
    const info = await initNetwork({ HTTP_PROXY: `http://user:secret@127.0.0.1:${port(proxy)}` });
    expect(info.proxy).toBe(`http://***@127.0.0.1:${port(proxy)}`);
    const res = await httpFetch('http://upstream.invalid/search?q=1', { method: 'GET' });
    expect(await res.text()).toBe('host=upstream.invalid');
    expect(seen).toEqual(['CONNECT upstream.invalid:80']);
  });

  it('本机地址默认不走代理（自建 SearXNG 常见）；用户设了 NO_PROXY 则以用户为准', async () => {
    const local = `http://127.0.0.1:${port(target)}/`;
    await initNetwork({ HTTP_PROXY: `http://127.0.0.1:${port(proxy)}` });
    expect(await (await httpFetch(local, { method: 'GET' })).text()).toBe(`host=127.0.0.1:${port(target)}`);
    expect(seen).toEqual([]);
    await initNetwork({ HTTP_PROXY: `http://127.0.0.1:${port(proxy)}`, NO_PROXY: 'example.invalid' });
    await (await httpFetch(local, { method: 'GET' })).text();
    expect(seen).toEqual([`CONNECT 127.0.0.1:${port(target)}`]);
  });

  it('没配代理或代理变量是未展开的模板时直连', async () => {
    expect(await initNetwork({})).toEqual({});
    expect(await initNetwork({ HTTPS_PROXY: '${env:HTTPS_PROXY}', http_proxy: '' })).toEqual({});
    expect(await (await httpFetch(`http://127.0.0.1:${port(target)}/`, { method: 'GET' })).text()).toBe(`host=127.0.0.1:${port(target)}`);
    expect(seen).toEqual([]);
  });

  it('没写协议的代理按 http:// 处理；不支持的代理只告警并直连，不让启动失败', async () => {
    expect(proxySettings({ HTTPS_PROXY: '127.0.0.1:7890' }).httpsProxy).toBe('http://127.0.0.1:7890');
    const socks = await initNetwork({ HTTPS_PROXY: 'socks5://u:p@127.0.0.1:1080' });
    expect(socks).toEqual({ error: expect.stringContaining('unsupported proxy socks5://***@127.0.0.1:1080') });
    expect(await (await httpFetch(`http://127.0.0.1:${port(target)}/`, { method: 'GET' })).text()).toBe(`host=127.0.0.1:${port(target)}`);
  });

  it('小写变量名同样生效；redactUrl 不泄露密码', () => {
    expect(proxySettings({ https_proxy: 'http://p:1', no_proxy: 'a' })).toEqual({ httpsProxy: 'http://p:1', httpProxy: undefined, noProxy: 'a' });
    expect(redactUrl('http://u:p@proxy.local:7890')).toBe('http://***@proxy.local:7890');
    expect(redactUrl('not a url')).toBe('(invalid proxy url)');
  });
});

it('网络错误的 detail 带上真实原因，而不只是 "fetch failed"', async () => {
  await initNetwork({});
  const closed = await listen(createServer());
  const closedPort = port(closed);
  closed.close();
  await once(closed, 'close');
  await expect(rawRequest(`http://127.0.0.1:${closedPort}/`, { method: 'GET' }, 'p'))
    .rejects.toMatchObject({ type: 'network', detail: expect.stringMatching(/^fetch failed: .*ECONNREFUSED/) });
});
