/** 凭据保持在叶子模块：adapter 与启用判断共用，不依赖 registry/config。 */
export const CREDENTIALS: Record<string, string | null> = {
  bocha: 'BOCHA_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  tavily: 'TAVILY_API_KEY',
  qianfan: 'QIANFAN_API_KEY',
  brave: 'BRAVE_API_KEY',
  serper: 'SERPER_API_KEY',
  exa: 'EXA_API_KEY',
  duckduckgo: null,
};

export function isConfigured(name: string): boolean {
  return CREDENTIALS[name] === null || !!apiKeyFor(name);
}

export function apiKeyFor(name: string): string | undefined {
  const key = CREDENTIALS[name];
  return key ? process.env[key] || undefined : undefined;
}
