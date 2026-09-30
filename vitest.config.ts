import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    // msw/node 是 CJS 入口，Vite 的 ESM 互操作会丢 named export（setupServer is not a function）
    server: { deps: { inline: ['msw'] } },
  },
});
