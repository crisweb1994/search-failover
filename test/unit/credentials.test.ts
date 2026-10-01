import { describe, expect, it, afterEach } from 'vitest';
import { apiKeyFor, isConfigured, CREDENTIALS } from '../../src/credentials.js';

describe('credentials 叶子模块（D15）', () => {
  const touched: string[] = [];
  const setEnv = (k: string, v: string | undefined) => {
    touched.push(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const k of touched) delete process.env[k];
    touched.length = 0;
    delete CREDENTIALS['fake-multi'];
    delete CREDENTIALS['fake-url'];
  });

  it('none 型（duckduckgo）永远 configured，apiKeyFor 返回 undefined', () => {
    expect(isConfigured('duckduckgo')).toBe(true);
    expect(apiKeyFor('duckduckgo')).toBeUndefined();
  });

  it('env 型：变量存在即 configured；apiKeyFor 取第一个非空值', () => {
    setEnv('BOCHA_API_KEY', 'k1');
    expect(isConfigured('bocha')).toBe(true);
    expect(apiKeyFor('bocha')).toBe('k1');

    setEnv('BOCHA_API_KEY', undefined);
    expect(isConfigured('bocha')).toBe(false);
    expect(apiKeyFor('bocha')).toBeUndefined();
  });

  it('env 多变量：任一存在即 configured，主凭据按 vars 顺序取', () => {
    CREDENTIALS['fake-multi'] = { kind: 'env', vars: ['FAKE_A', 'FAKE_B'] };
    setEnv('FAKE_B', 'second');
    expect(isConfigured('fake-multi')).toBe(true);
    expect(apiKeyFor('fake-multi')).toBe('second');

    setEnv('FAKE_A', 'first');
    expect(apiKeyFor('fake-multi')).toBe('first'); // vars[0] 优先
  });

  it('url 型（Phase 3 预留）：变量非空即 configured', () => {
    CREDENTIALS['fake-url'] = { kind: 'url', var: 'FAKE_URL' };
    expect(isConfigured('fake-url')).toBe(false);
    setEnv('FAKE_URL', 'http://localhost:8888');
    expect(isConfigured('fake-url')).toBe(true);
    expect(apiKeyFor('fake-url')).toBeUndefined();
  });

  it('未注册名：configured=false', () => {
    expect(isConfigured('nope')).toBe(false);
    expect(apiKeyFor('nope')).toBeUndefined();
  });
});
