import { describe, expect, it, afterEach, vi } from 'vitest';
import { apiKeyFor, isConfigured } from '../../src/credentials.js';

describe('credentials 叶子模块（D15）', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('none 型（duckduckgo）永远 configured，apiKeyFor 返回 undefined', () => {
    expect(isConfigured('duckduckgo')).toBe(true);
    expect(apiKeyFor('duckduckgo')).toBeUndefined();
  });

  it('变量非空即 configured；缺失或空串不启用', () => {
    vi.stubEnv('BOCHA_API_KEY', 'k1');
    expect(isConfigured('bocha')).toBe(true);
    expect(apiKeyFor('bocha')).toBe('k1');

    vi.stubEnv('BOCHA_API_KEY', undefined);
    expect(isConfigured('bocha')).toBe(false);
    expect(apiKeyFor('bocha')).toBeUndefined();
    vi.stubEnv('BOCHA_API_KEY', '');
    expect(isConfigured('bocha')).toBe(false);
    expect(apiKeyFor('bocha')).toBeUndefined();
  });

  it('未注册名：configured=false', () => {
    expect(isConfigured('nope')).toBe(false);
    expect(apiKeyFor('nope')).toBeUndefined();
  });
});
