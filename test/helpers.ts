import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { setupServer } from 'msw/node';
import type { SetupServer } from 'msw/node';
import { parseConfig, type ProviderCfg, type QuotaCfg } from '../src/config.js';
import { buildRuntime, type Runtime } from '../src/runtime.js';
import type { ProviderEntry } from '../src/router.js';
import { ProviderError, type ProviderAdapter } from '../src/types.js';

/** 每个契约测试文件调用一次：拦截全局 fetch，未匹配请求直接报错 */
export function useMsw(): SetupServer {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

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

/** 测试用来源配置：默认无本地额度 */
export function cfg(name: string, over: Partial<Omit<ProviderCfg, 'quota'>> & { quota?: QuotaCfg } = {}): ProviderCfg {
  return { name, quota: { type: 'unbounded' }, quota_retry_s: 21600, ...over };
}

/**
 * 测试用 runtime：配置按 parseConfig 解析（env 默认为空，不读真实环境），
 * 再用给定的 adapter 替换运行链。
 */
export function testRuntime(
  adapters: (ProviderAdapter | ProviderEntry)[] = [],
  input: Record<string, unknown> = {},
  over: Partial<Runtime> = {},
): Runtime {
  const runtime = buildRuntime({ config: parseConfig(input, {}) }, { env: {} });
  const providers = adapters.map(a => ('cfg' in a ? a : { cfg: cfg(a.name), adapter: a }));
  return {
    ...runtime,
    config: { ...runtime.config, providers: providers.map(p => p.cfg) },
    providers,
    configured: new Set(providers.map(p => p.cfg.name)),
    ...over,
  };
}
