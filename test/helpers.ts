import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';
import type { SetupServer } from 'msw/node';

/** 每个契约测试文件调用一次：拦截全局 fetch，未匹配请求直接报错 */
export function useMsw(): SetupServer {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

import { expect } from 'vitest';
import { ProviderError } from '../src/types.js';

/** 断言 promise 以指定类别的 ProviderError 拒绝，返回完整错误供进一步断言 */
export async function expectProviderError(p: Promise<unknown>, type: string): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    const err = e as ProviderError;
    expect(err.type).toBe(type);
    return err;
  }
  throw new Error(`期望抛出 ProviderError(${type})，但正常返回了`);
}
