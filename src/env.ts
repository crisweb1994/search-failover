/**
 * 环境变量读取。各宿主对模板的处理不一致：Cursor 展开 `${env:X}`，ZCode 不展开，
 * 插件变量没填时可能原样透传 `${X}`。未展开的模板和空串一律视为未设置，
 * 否则模板字符串会被当成真 key 发给上游，401 后来源被摘除，诊断方向也是错的。
 */
const TEMPLATE = /^\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)$/;

export type Env = Record<string, string | undefined>;

/** 去掉首尾空白；空串和未展开的模板返回 undefined */
export function cleanValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && !TEMPLATE.test(value) ? value : undefined;
}

export function readEnv(name: string, env: Env = process.env): string | undefined {
  return cleanValue(env[name]);
}

/** 值看起来是未展开模板的变量名（供 status 和日志提示） */
export function unexpandedEnv(names: readonly string[], env: Env = process.env): string[] {
  return names.filter(name => {
    const value = env[name]?.trim();
    return !!value && TEMPLATE.test(value);
  });
}
