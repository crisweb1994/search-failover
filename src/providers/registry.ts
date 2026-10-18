import type { ProviderDefinition } from './types.js';
import { definition as bocha } from './bocha.js';
import { definition as zhipu } from './zhipu.js';
import { definition as deepseek } from './deepseek.js';
import { definition as tavily } from './tavily.js';
import { definition as qianfan } from './qianfan.js';
import { definition as brave } from './brave.js';
import { definition as serper } from './serper.js';
import { definition as exa } from './exa.js';
import { definition as searxng } from './searxng.js';
import { definition as duckduckgo } from './ddg.js';

/**
 * 来源注册表：名单的单一事实来源。数组顺序就是默认优先级，默认链 = 其中 defaultEnabled 的源。
 * 默认配置、工具描述、status、插件清单与文档表格都从这里派生（见 scripts/plugin-sync.mjs）。
 * 接入新源：新建 adapter 模块导出 definition，在这里加一行，再补契约测试。
 */
export const PROVIDERS: readonly ProviderDefinition[] = [
  bocha, zhipu, deepseek, tavily, qianfan, brave, serper, exa, searxng, duckduckgo,
];

export const REGISTRY: Readonly<Record<string, ProviderDefinition>> = Object.fromEntries(
  PROVIDERS.map(def => [def.adapter.name, def]),
);

/** 所有来源的凭据环境变量名（key 或实例地址） */
export const CREDENTIAL_ENVS: readonly string[] = PROVIDERS.flatMap(def => (def.credentialEnv ? [def.credentialEnv] : []));

export const PROVIDER_NAMES: readonly string[] = PROVIDERS.map(def => def.adapter.name);
