import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeConfigError, loadConfig, parseConfig, userConfigPath } from '../../src/config.js';

const names = (input: unknown, env: Record<string, string> = {}) => parseConfig(input, env).providers.map(p => p.name);

describe('运行链：名单与顺序', () => {
  it('不指定名单用默认链；空名单就是空链', () => {
    expect(names({})).toEqual(['bocha', 'tavily', 'brave', 'exa', 'searxng', 'duckduckgo']);
    expect(names({ providers: [] })).toEqual([]);
  });

  it('配置文件：数组顺序就是优先级，列出即启用，enabled:false 暂时停用', () => {
    expect(names({ providers: [{ name: 'duckduckgo' }, { name: 'serper' }, { name: 'bocha', enabled: false }, { name: 'exa' }] }))
      .toEqual(['duckduckgo', 'serper', 'exa']);
  });

  it('SEARCH_FAILOVER_PROVIDERS 覆盖文件名单，顺序即优先级，可选源列出即启用；文件里的调优仍然生效', () => {
    const config = parseConfig(
      { providers: [{ name: 'tavily' }, { name: 'serper', enabled: false, quota: { limit: 10 } }] },
      { SEARCH_FAILOVER_PROVIDERS: ' Serper, duckduckgo ,, tavily ' },
    );
    expect(config.providers.map(p => p.name)).toEqual(['serper', 'duckduckgo', 'tavily']);
    expect(config.providers[0]).toMatchObject({ quota: { type: 'one_time', limit: 10 }, local_qps: 1 });
  });

  it('SEARCH_FAILOVER_PROVIDERS 是未展开的模板时视为未设置', () => {
    expect(names({}, { SEARCH_FAILOVER_PROVIDERS: '${env:SEARCH_FAILOVER_PROVIDERS}' })).toContain('bocha');
  });

  it.each([
    ['tavily,google', 'SEARCH_FAILOVER_PROVIDERS: unknown provider "google"'],
    ['tavily,tavily', 'SEARCH_FAILOVER_PROVIDERS: duplicate provider "tavily"'],
  ])('环境变量里的未知或重复来源报错：%s', (value, message) => {
    expect(() => parseConfig({}, { SEARCH_FAILOVER_PROVIDERS: value })).toThrow(message);
  });
});

describe('来源条目继承默认值', () => {
  it('省略的字段继承注册表默认值', () => {
    const [brave, qianfan, ddg] = parseConfig({ providers: [{ name: 'brave' }, { name: 'qianfan' }, { name: 'duckduckgo' }] }, {}).providers;
    expect(brave).toMatchObject({ local_qps: 1, quota: { limit: 1000 }, quota_retry_s: 21600 });
    expect(qianfan).toMatchObject({ local_qps: 1, quota: { limit: 1500 } });
    expect(ddg).toMatchObject({ min_interval_ms: 2000, cooldown_max_s: 21600 });
  });

  it('quota 类型不变时按字段合并，切换类型时整体替换', () => {
    const quota = (q: Record<string, unknown>) => parseConfig({ providers: [{ name: 'brave', quota: q }] }, {}).providers[0]?.quota;
    expect(quota({ limit: 0 })).toEqual({ type: 'monthly', limit: 0, reset_day: 15 });
    expect(quota({ type: 'unbounded' })).toEqual({ type: 'unbounded' });
    expect(quota({ type: 'one_time', limit: 5 })).toEqual({ type: 'one_time', limit: 5 });
  });

  it('顶层字段覆盖：quota_retry_s 含 0', () => {
    expect(parseConfig({ providers: [{ name: 'brave', quota_retry_s: 0 }] }, {}).providers[0]?.quota_retry_s).toBe(0);
  });
});

describe('credentials：所有宿主共用的凭据', () => {
  it('键必须是已知的凭据环境变量名；空值和模板忽略', () => {
    const config = parseConfig({ credentials: { TAVILY_API_KEY: ' tvly-1 ', BRAVE_API_KEY: '', EXA_API_KEY: '${EXA_API_KEY}' } }, {});
    expect(config.credentials).toEqual({ TAVILY_API_KEY: 'tvly-1' });
    expect(() => parseConfig({ credentials: { GOOGLE_API_KEY: 'x' } }, {})).toThrow('credentials.GOOGLE_API_KEY: unknown key');
  });
});

describe('拒绝未知字段与非法值，并指出位置', () => {
  it.each([
    ['来源层：enabled 拼成 enabeld', { providers: [{ name: 'zhipu', enabeld: true }] }, 'providers.0: unknown field "enabeld"'],
    ['quota 层：limit 拼成 limt（付费来源的本地上限会悄悄失效）',
      { providers: [{ name: 'zhipu', quota: { type: 'one_time', limt: 100 } }] }, 'providers.0.quota: unknown field "limt"'],
    ['顶层：cache 拼成 cahce', { cahce: { enabled: false } }, '(root): unknown field "cahce"'],
    ['cache 层：ttl_s 拼成 ttl', { cache: { ttl: 10 } }, 'cache: unknown field "ttl"'],
    ['defaults 层：timeout_ms 拼成 timeout', { defaults: { timeout: 3000 } }, 'defaults: unknown field "timeout"'],
    ['priority 已移除：顺序由数组决定', { providers: [{ name: 'brave', priority: 1 }] }, 'providers.0: unknown field "priority"'],
    ['旧字段不再接受', { providers: [{ name: 'exa', fetch_policy: 'cache_fill' }] }, 'providers.0: unknown field "fetch_policy"'],
    ['旧字段不再接受', { cache: { store_size: 2 } }, 'cache: unknown field "store_size"'],
    ['旧字段不再接受', { providers: [{ name: 'exa', quota: { quota_retry_s: 60 } }] }, 'providers.0.quota: unknown field "quota_retry_s"'],
  ])('%s', (_label, value, message) => {
    let error: unknown;
    try { parseConfig(value, {}); } catch (e) { error = e; }
    expect(describeConfigError(error)).toBe(message);
  });

  it.each([
    null, [], { providers: null }, { providers: [{ name: 'unknown' }] },
    { providers: [{ name: 'brave' }, { name: 'brave' }] },
    ...[0, -1, 0.5, Infinity].map(timeout_ms => ({ defaults: { timeout_ms } })),
    { defaults: { cooldown_max_s: -1 } },
    { defaults: { max_output_chars: 0 } },
    ...[-1, Infinity, NaN, '600', null].map(value => ({ providers: [{ name: 'brave', quota_retry_s: value }] })),
    ...[{ local_qps: 0 }, { min_interval_ms: -1 }, { quota: { limit: -1 } }, { enabled: 'true' }, { quota: { type: 'weekly' } }]
      .map(over => ({ providers: [{ name: 'brave', ...over }] })),
  ])('拒绝不合法配置 %#', value => { expect(() => parseConfig(value, {})).toThrow(); });
});

describe('loadConfig：查找位置与错误处理', () => {
  const dirs: string[] = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'sf-config-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('用户级配置文件：XDG_CONFIG_HOME 优先，其次 HOME/.config；Windows 用 APPDATA', () => {
    expect(userConfigPath({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(join('/x', 'search-failover', 'config.json'));
    expect(userConfigPath({ HOME: '/home/u' }, 'darwin')).toBe(join('/home/u', '.config', 'search-failover', 'config.json'));
    expect(userConfigPath({ HOME: '/home/u', APPDATA: '/appdata' }, 'win32')).toBe(join('/appdata', 'search-failover', 'config.json'));
  });

  it('用户级文件存在就读取；不存在就用默认值；从不读当前目录', () => {
    const xdg = tmp();
    const cwd = tmp();
    writeFileSync(join(cwd, 'search-failover.json'), JSON.stringify({ providers: [{ name: 'serper', quota: { type: 'unbounded' } }] }));
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      const missing = loadConfig({ XDG_CONFIG_HOME: xdg });
      expect([missing.source, missing.error]).toEqual([undefined, undefined]);
      expect(missing.config.providers.map(p => p.name)).not.toContain('serper');

      mkdirSync(join(xdg, 'search-failover'));
      writeFileSync(join(xdg, 'search-failover', 'config.json'), JSON.stringify({ providers: [{ name: 'tavily' }], credentials: { TAVILY_API_KEY: 'k' } }));
      const found = loadConfig({ XDG_CONFIG_HOME: xdg });
      expect(found.source).toBe(join(xdg, 'search-failover', 'config.json'));
      expect(found.config.providers.map(p => p.name)).toEqual(['tavily']);
      expect(found.config.credentials).toEqual({ TAVILY_API_KEY: 'k' });
    } finally {
      process.chdir(previous);
    }
  });

  it('显式路径不存在、JSON 损坏、字段非法都返回 error 和空链，而不是抛出', () => {
    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const typo = join(dir, 'typo.json');
    writeFileSync(typo, JSON.stringify({ providers: [{ name: 'zhipu', quota: { limt: 1 } }] }));

    const missing = loadConfig({ SEARCH_FAILOVER_CONFIG: join(dir, 'nope.json') });
    expect(missing.error).toContain('cannot read');
    expect(missing.config.providers).toEqual([]);
    expect(loadConfig({ SEARCH_FAILOVER_CONFIG: bad }).error).toContain('cannot read');
    expect(loadConfig({ SEARCH_FAILOVER_CONFIG: typo }).error).toBe(`${typo}: providers.0.quota: unknown field "limt"`);
    // 环境变量的错误不冠以文件路径
    expect(loadConfig({ XDG_CONFIG_HOME: dir, SEARCH_FAILOVER_PROVIDERS: 'nope' }).error).toMatch(/^SEARCH_FAILOVER_PROVIDERS: unknown provider/);
  });

  it('SEARCH_FAILOVER_CONFIG 为空串或未展开的模板时退回用户级文件', () => {
    const xdg = tmp();
    for (const value of ['', '${CONFIG_PATH}', '${user_config.config_path}']) {
      const loaded = loadConfig({ SEARCH_FAILOVER_CONFIG: value, XDG_CONFIG_HOME: xdg });
      expect([loaded.source, loaded.error], value).toEqual([undefined, undefined]);
    }
  });
});
