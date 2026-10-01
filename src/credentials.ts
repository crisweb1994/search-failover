/**
 * 凭据叶子模块（D15）：provider 名单的凭据事实来源。
 * 必须保持零 import（尤其不能 import config/registry/adapter）——
 * 它被 adapter（取 key）与 config/registry（生成默认配置）共同依赖，
 * 任何反向依赖都会成环（见 provider-expansion-spec §1.1）。
 */

export type CredentialSpec =
  | { kind: 'none' }                        // 无需凭据，永远视为已配置（duckduckgo）
  | { kind: 'env'; vars: string[] }         // 任一环境变量非空即已配置；vars[0..] 依次取主凭据
  | { kind: 'url'; var: string };           // URL 型（SearXNG 等，Phase 3 预留，当前无实例）

/** 各源凭据声明（取代原 config.ENV_KEYS 的单一变量映射） */
export const CREDENTIALS: Record<string, CredentialSpec> = {
  bocha: { kind: 'env', vars: ['BOCHA_API_KEY'] },
  zhipu: { kind: 'env', vars: ['ZHIPU_API_KEY'] },
  tavily: { kind: 'env', vars: ['TAVILY_API_KEY'] },
  qianfan: { kind: 'env', vars: ['QIANFAN_API_KEY'] },
  brave: { kind: 'env', vars: ['BRAVE_API_KEY'] },
  serper: { kind: 'env', vars: ['SERPER_API_KEY'] },
  exa: { kind: 'env', vars: ['EXA_API_KEY'] },
  duckduckgo: { kind: 'none' },
};

/** 是否具备运行条件（有 key / 有 URL / 无需凭据）。与 enabled（用户意愿）正交。 */
export function isConfigured(name: string): boolean {
  const c = CREDENTIALS[name];
  if (!c) return false;
  switch (c.kind) {
    case 'none': return true;
    case 'env': return c.vars.some(v => !!process.env[v]);
    case 'url': return !!process.env[c.var];
  }
}

/** env 型源的主凭据：vars 中第一个非空值；非 env 型返回 undefined */
export function apiKeyFor(name: string): string | undefined {
  const c = CREDENTIALS[name];
  if (!c || c.kind !== 'env') return undefined;
  for (const v of c.vars) {
    const val = process.env[v];
    if (val) return val;
  }
  return undefined;
}
