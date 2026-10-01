import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { REGISTRY } from '../../src/providers/registry.js';

/**
 * e2e：真实子进程起服（stdio），验证——
 * ① stdout 每一行都是合法 JSON-RPC（工程红线：stdout 纯净性守卫，验收 11 一部分）
 * ② tools/list 能发现 search / status（验收 11）
 * ③ status 返回全部注册源状态（无 key 环境下仅 DDG active，其余 unconfigured，验收 12）
 */

interface Msg { jsonrpc: string; id?: number; method?: string; result?: any; error?: any }

function startServer(): { child: ChildProcess; send: (m: object) => void; messages: Msg[]; done: Promise<void> } {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOG: 'error',
      BOCHA_API_KEY: '', TAVILY_API_KEY: '', BRAVE_API_KEY: '', EXA_API_KEY: '',
      ZHIPU_API_KEY: '', QIANFAN_API_KEY: '', SERPER_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const messages: Msg[] = [];
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) messages.push(JSON.parse(line)); // 解析失败会直接让测试红掉 = stdout 不纯
    }
  });

  const send = (m: object) => child.stdin!.write(`${JSON.stringify(m)}\n`);
  const done = new Promise<void>((resolve, reject) => {
    child.on('exit', () => resolve());
    child.stderr!.setEncoding('utf8');
    const errChunks: string[] = [];
    child.stderr!.on('data', (c: string) => errChunks.push(c));
    setTimeout(() => reject(new Error(`server 未在时限内响应。stderr: ${errChunks.join('').slice(0, 2000)}`)), 15000);
  });

  return { child, send, messages, done };
}

const waitfor = async (messages: Msg[], id: number): Promise<Msg> => {
  for (let i = 0; i < 200; i++) {
    const found = messages.find(m => m.id === id && m.result !== undefined);
    if (found) return found;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`未收到 id=${id} 的响应`);
};

describe('stdio e2e', () => {
  it('起服 → initialize → tools/list → status 调用', async () => {
    const s = startServer();
    try {
      s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
      await waitfor(s.messages, 1);
      s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = await waitfor(s.messages, 2);
      const names = tools.result.tools.map((t: any) => t.name);
      expect(names).toContain('search');
      expect(names).toContain('status');

      s.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
      const status = await waitfor(s.messages, 3);
      const payload = JSON.parse(status.result.content[0].text);
      const byName = Object.fromEntries(payload.providers.map((p: any) => [p.name, p.state]));
      expect(payload.providers).toHaveLength(Object.keys(REGISTRY).length);
      expect(byName['duckduckgo']).toBe('active');
      expect(byName['bocha']).toBe('unconfigured');
      expect(byName['zhipu']).toBe('unconfigured'); // 无 key 时 unconfigured 优先于 opt-in 的 disabled
      expect(typeof payload.uptime_s).toBe('number');
    } finally {
      s.child.kill();
      await s.done;
    }
  }, 25000);
});
