import pkg from '../package.json' with { type: 'json' };

/** 版本号单一来源：构建时由 esbuild 内联 package.json */
export const VERSION: string = pkg.version;
