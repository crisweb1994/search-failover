import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { useMsw, expectProviderError } from '../helpers.js';
import { rawRequest, MAX_BODY_CHARS } from '../../src/providers/types.js';

const server = useMsw();

describe('rawRequest 响应体上限（防御：异常大响应不无界读入）', () => {
  it('超过 MAX_BODY_CHARS 的响应明确报错', async () => {
    server.use(http.get('https://big.example.com/', () =>
      new HttpResponse('x'.repeat(MAX_BODY_CHARS + 50_000), { headers: { 'Content-Type': 'text/plain' } })));
    const err = await expectProviderError(rawRequest('https://big.example.com/', { method: 'GET' }, 'test'), 'server_error');
    expect(err.detail).toBe('response_too_large');
  });

  it('正常小响应原样返回', async () => {
    server.use(http.get('https://ok.example.com/', () => HttpResponse.json({ ok: true })));
    const res = await rawRequest('https://ok.example.com/', { method: 'GET' }, 'test');
    expect(res.bodyText).toBe('{"ok":true}');
  });

  it('网络异常 → ProviderError(network)', async () => {
    server.use(http.get('https://down.example.com/', () => HttpResponse.error()));
    await expectProviderError(rawRequest('https://down.example.com/', { method: 'GET' }, 'test'), 'network');
  });
});
