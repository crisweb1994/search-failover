#!/usr/bin/env node
/**
 * 打成单文件、零运行时依赖：npx 冷启动只需下载一个包（宿主普遍有 10～30 秒的启动超时），
 * 消费者安装时也不会漂到未测试过的依赖版本（npm 不读依赖包里的 lockfile）。
 * 保留标识符，用户贴回来的堆栈仍然可读。
 */
import { rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = `${root}dist/index.js`;

rmSync(`${root}dist`, { recursive: true, force: true });
await build({
  entryPoints: [`${root}src/index.ts`],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.10',
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  // 依赖里的 CommonJS 模块会 require Node 内置模块，ESM 产物需要一个真正的 require
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log(`built dist/index.js (${(statSync(outfile).size / 1024).toFixed(0)} KB)`);
