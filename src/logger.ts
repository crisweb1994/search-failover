/**
 * stderr-only logger。stdout 是 MCP 协议通道，任何日志写 stdout 都会打断宿主连接（工程红线 §1.3）。
 * 级别由环境变量 LOG 控制：error | warn | info | debug，缺省 info。
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

const envLevel = (process.env['LOG'] ?? 'info') as Level;
const current = LEVELS[envLevel] ?? LEVELS.info;

function write(level: Level, msg: string): void {
  if (LEVELS[level] <= current) {
    process.stderr.write(`[${level}] ${new Date().toISOString()} ${msg}\n`);
  }
}

export const log = {
  error: (msg: string) => write('error', msg),
  info: (msg: string) => write('info', msg),
};
