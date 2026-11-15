import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

/**
 * DeepSeek Harness（dsh）插件包：package.json 的 dsh.bundle、补丁文件、展示用的 locale 与图标。
 * dsh 只在安装时才读这些文件，写坏了没有任何提示，所以发布前在这里校验，并确认它们都进了发布包。
 */
const read = (path: string) => readFileSync(resolve(path), 'utf8');
const pkg = JSON.parse(read('package.json'));

it('package.json 声明了 dsh bundle，补丁文件存在', () => {
  expect(pkg.dsh.manifestVersion).toBe(1);
  expect(pkg.dsh.bundle.patch).toBe('./dsh/cordis.patch.yml');
  expect(existsSync(resolve(pkg.dsh.bundle.patch))).toBe(true);
  // 市场索引生成器只收公开、声明了 dsh.bundle 的包；engines.dsh 缺失时 dsh 不做任何版本检查
  expect(pkg.private).not.toBe(true);
  expect(pkg.engines.dsh).toMatch(/^>=\S+/);
  expect(pkg.keywords).toEqual(expect.arrayContaining(['dsh-plugin', 'deepseek-harness']));
});

it('补丁只插入一条 stdio MCP 条目：serverName 合法，不固定版本，不带密钥', () => {
  const body = read('dsh/cordis.patch.yml').split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  expect(body).toMatch(/^- insert:\n {4}- id: mcp-search-failover\n {6}name: '@deepseek-ai\/dsh-mcp-client'\n {6}config:\n/);
  const field = (key: string) => new RegExp(`^ {8}${key}: (.+)$`, 'm').exec(body)?.[1];
  expect(field('transport')).toBe('stdio');
  expect(field('command')).toBe('npx');
  expect(field('args')).toBe("['-y', 'search-failover']");
  expect(field('env')).toBe('{}');
  // dsh 的 serverName 限 [A-Za-z0-9_-]{1,32}，模型看到的工具名是 mcp__<serverName>__<tool>
  expect(field('serverName')).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  // 补丁随 npm 包一起发布，写不进自己尚未发布的版本号；兼容性由 engines.dsh 约束
  expect(body).not.toContain('search-failover@');
  // 密钥只放用户级配置文件，补丁里不放 !!js 表达式和 ${...} 模板
  expect(body).not.toMatch(/!!js|\$\{/);
});

it('locale 提供英文和中文的名称与简介', () => {
  for (const lang of ['en', 'zh']) {
    const { meta } = JSON.parse(read(`locale/${lang}.json`));
    expect(meta.title.trim().length, `${lang} title`).toBeGreaterThan(0);
    expect(meta.description.trim().length, `${lang} description`).toBeGreaterThan(0);
  }
});

it('图标是不超过 256 KiB 的 SVG', () => {
  const icon = resolve(pkg.icon);
  expect(icon.endsWith('.svg')).toBe(true);
  expect(statSync(icon).size).toBeLessThanOrEqual(256 * 1024);
  expect(readFileSync(icon, 'utf8').trimStart()).toMatch(/^<svg[\s>]/);
});

it('这些文件都进了发布包', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  const packed = new Set<string>(JSON.parse(out)[0].files.map((file: { path: string }) => file.path));
  for (const path of ['package.json', 'dsh/cordis.patch.yml', 'dsh/icon.svg', 'locale/en.json', 'locale/zh.json']) {
    expect(packed.has(path), path).toBe(true);
  }
}, 30000);
