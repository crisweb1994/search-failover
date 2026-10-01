import { describe, expect, it } from 'vitest';
import { REGISTRY } from '../../src/providers/registry.js';
import { CREDENTIALS } from '../../src/credentials.js';
import { defaultChainDescribe, domainFilterDescribe, providerParamDescribe } from '../../src/providers/describe.js';

/** 注册表一致性（D15）：名单单一事实来源的守卫测试 */
describe('REGISTRY 一致性', () => {
  it('注册键 = adapter.name，凭据声明一一对应', () => {
    for (const [name, r] of Object.entries(REGISTRY)) {
      expect(r.adapter.name, `adapter.name of ${name}`).toBe(name);
      expect(r.credential, `credential of ${name}`).toBe(CREDENTIALS[name]);
    }
  });

  it('priority 无重复；无环依赖兜底：duckduckgo 是 defaultEnabled 的最后一家', () => {
    const ps = Object.values(REGISTRY).map(r => r.priority);
    expect(new Set(ps).size).toBe(ps.length);
    const enabled = Object.values(REGISTRY)
      .filter(r => r.defaultEnabled)
      .sort((a, b) => a.priority - b.priority)
      .map(r => r.adapter.name);
    expect(enabled[enabled.length - 1]).toBe('duckduckgo');
    expect(enabled).toContain('bocha');
  });

  it('能力矩阵与 describe 派生文本一致：全部源名出现，域名过滤按能力分组', () => {
    const p = providerParamDescribe();
    for (const name of Object.keys(REGISTRY)) expect(p).toContain(name);

    const d = domainFilterDescribe();
    for (const [name, r] of Object.entries(REGISTRY)) {
      if (r.capabilities.includeDomains === 'native') expect(d).toContain(name);
      if (r.capabilities.includeDomains === 'single') expect(d).toContain(name);
      if (r.capabilities.includeDomains === 'none') expect(d).toContain(name);
    }
    expect(d).toContain('原生支持');
    expect(d).toContain('单域名');
  });

  it('defaultChainDescribe：默认链五家 + 可选源列出 opt-in 三家', () => {
    const d = defaultChainDescribe();
    expect(d).toContain('bocha → tavily → brave → exa → duckduckgo');
    expect(d).toContain('zhipu');
    expect(d).toContain('qianfan');
    expect(d).toContain('serper');
  });
});
