import { describe, expect, it } from 'vitest';
import { cleanValue, readEnv, unexpandedEnv } from '../../src/env.js';
import { parseConfig } from '../../src/config.js';
import { buildRuntime, resolveCredential } from '../../src/runtime.js';
import { REGISTRY } from '../../src/providers/registry.js';

describe('环境变量清洗：空串和未展开的模板视为未设置', () => {
  it.each([
    ['${BOCHA_API_KEY}', undefined], ['${env:BOCHA_API_KEY}', undefined], ['${user_config.config_path}', undefined],
    ['$BOCHA_API_KEY', undefined], ['', undefined], ['   ', undefined], [undefined, undefined],
    [' sk-abc \n', 'sk-abc'], ['http://localhost:8080', 'http://localhost:8080'], ['a$b', 'a$b'],
  ])('%j → %j', (raw, expected) => {
    expect(cleanValue(raw)).toBe(expected);
  });

  it('readEnv / unexpandedEnv', () => {
    const env = { A: '${env:A}', B: 'b', C: '' };
    expect(readEnv('A', env)).toBeUndefined();
    expect(readEnv('B', env)).toBe('b');
    expect(unexpandedEnv(['A', 'B', 'C', 'D'], env)).toEqual(['A']);
  });
});

describe('凭据解析与运行链', () => {
  it('环境变量优先，其次是配置文件 credentials；模板值不算', () => {
    const tavily = REGISTRY['tavily']!;
    expect(resolveCredential(tavily, { TAVILY_API_KEY: 'file' }, { TAVILY_API_KEY: 'env' })).toBe('env');
    expect(resolveCredential(tavily, { TAVILY_API_KEY: 'file' }, { TAVILY_API_KEY: '${env:TAVILY_API_KEY}' })).toBe('file');
    expect(resolveCredential(tavily, {}, {})).toBeUndefined();
    expect(resolveCredential(REGISTRY['duckduckgo']!, {}, {})).toBeUndefined();
  });

  it('缺凭据的来源不进运行链；未展开的模板会出现在 warnings 里', () => {
    const env = { TAVILY_API_KEY: 'k', BOCHA_API_KEY: '${env:BOCHA_API_KEY}', SEARXNG_URL: 'http://localhost:8080' };
    const rt = buildRuntime({ config: parseConfig({}, env) }, { env });
    expect(rt.providers.map(p => p.cfg.name)).toEqual(['tavily', 'searxng', 'duckduckgo']);
    expect(rt.providers.find(p => p.cfg.name === 'searxng')?.credential).toBe('http://localhost:8080');
    expect(rt.configured.has('bocha')).toBe(false);
    expect(rt.warnings).toEqual(['BOCHA_API_KEY looks like an unexpanded template (${env:BOCHA_API_KEY}); treated as unset']);
  });

  it('配置文件里的凭据让来源进链；SEARCH_FAILOVER_DEBUG 打开调试参数', () => {
    const env = { SEARCH_FAILOVER_DEBUG: 'true' };
    const rt = buildRuntime({ config: parseConfig({ credentials: { BRAVE_API_KEY: 'b' } }, env) }, { env });
    expect(rt.providers.map(p => p.cfg.name)).toEqual(['brave', 'duckduckgo']);
    expect(rt.debug).toBe(true);
  });
});
