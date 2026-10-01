import { REGISTRY, type DomainFilterCap } from './registry.js';

/**
 * MCP describe 派生文本（D15）：从注册表生成，接新源时 describe 自动跟上，
 * 不再手写名单。依赖方向：describe → registry（单向）。
 */

/** `provider` 参数的枚举说明 */
export function providerParamDescribe(): string {
  const names = Object.values(REGISTRY).map(r => r.adapter.name);
  return `强制指定单一源（调试用）：${names.join(' | ')}`;
}

/** `include_domains` 参数的能力分组说明 */
export function domainFilterDescribe(): string {
  const groups: Record<DomainFilterCap, string[]> = { native: [], single: [], none: [] };
  for (const r of Object.values(REGISTRY)) groups[r.capabilities.includeDomains].push(r.adapter.name);
  const parts: string[] = [];
  if (groups.native.length) parts.push(`${groups.native.join('/')} 原生支持`);
  if (groups.single.length) parts.push(`${groups.single.join('/')} 支持单域名`);
  if (groups.none.length) parts.push(`${groups.none.join('/')} 忽略该参数并在 note 说明`);
  return `仅返回这些域名的结果（${parts.join('，')}）`;
}

/** 默认链一览（search 工具总描述用；enabled 默认源按 priority） */
export function defaultChainDescribe(): string {
  const chain = Object.values(REGISTRY)
    .filter(r => r.defaultEnabled)
    .sort((a, b) => a.priority - b.priority)
    .map(r => r.adapter.name);
  const optIn = Object.values(REGISTRY).filter(r => !r.defaultEnabled).map(r => r.adapter.name);
  return `默认链：${chain.join(' → ')}${optIn.length ? `；可选源（配置文件显式开启）：${optIn.join('/')}` : ''}`;
}
