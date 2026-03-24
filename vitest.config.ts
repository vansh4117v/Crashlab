import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

const pkg = (name: string) => path.resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    globals: true,
    testTimeout: 10_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@crashlab/clock': pkg('clock'),
      '@crashlab/random': pkg('random'),
      '@crashlab/http-proxy': pkg('http-proxy'),
      '@crashlab/scheduler': pkg('scheduler'),
      '@crashlab/tcp': pkg('tcp'),
      '@crashlab/pg-mock': pkg('pg-mock'),
      '@crashlab/redis-mock': pkg('redis-mock'),
      '@crashlab/filesystem': pkg('filesystem'),
      '@crashlab/mongo': pkg('mongo'),
      '@crashlab/core': pkg('core'),
      'crashlab': pkg('crashlab'),
    },
  },
});
