import { describe, expect, it } from 'vitest';
import { CREDENTIAL_ENVS, PROVIDERS, REGISTRY } from '../../src/providers/registry.js';
import { includeDomainsDescription, providerParamDescription, searchDescription } from '../../src/providers/describe.js';
import { parseConfig } from '../../src/config.js';
import { buildRuntime } from '../../src/runtime.js';

const runtime = (env: Record<string, string>, input: Record<string, unknown> = {}) =>
  buildRuntime({ config: parseConfig(input, env) }, { env });

describe('注册表一致性', () => {
  it('名字唯一、注册键 = adapter.name；凭据变量唯一', () => {
    const names = PROVIDERS.map(d => d.adapter.name);
    expect(new Set(names).size).toBe(names.length);
    for (const [name, def] of Object.entries(REGISTRY)) expect(def.adapter.name).toBe(name);
    expect(new Set(CREDENTIAL_ENVS).size).toBe(CREDENTIAL_ENVS.length);
    expect(CREDENTIAL_ENVS).toContain('SEARXNG_URL');
  });

  it('免凭据的 duckduckgo 是默认链最后一家（零配置兜底）', () => {
    const chain = PROVIDERS.filter(d => d.defaultEnabled);
    expect(chain.at(-1)?.adapter.name).toBe('duckduckgo');
    expect(chain.at(-1)?.credentialEnv).toBeNull();
  });
});

describe('给模型的描述按实际运行链生成', () => {
  it('只列出可运行的来源，不列没配置的', () => {
    const rt = runtime({ TAVILY_API_KEY: 'k', BRAVE_API_KEY: 'k' });
    const description = searchDescription(rt);
    expect(description).toContain('Active chain: tavily → brave → duckduckgo.');
    expect(description).not.toContain('bocha');
    expect(includeDomainsDescription(rt)).toContain('tavily: any number of domains; brave, duckduckgo: one domain');
    expect(providerParamDescription(rt)).toContain('One of: tavily, brave, duckduckgo.');
  });

  it('空链和配置错误时描述直接说明', () => {
    expect(searchDescription(runtime({}, { providers: [] }))).toContain('No search provider is configured');
    expect(searchDescription({ ...runtime({}), configError: 'x' })).toContain('configuration is invalid');
  });
});
