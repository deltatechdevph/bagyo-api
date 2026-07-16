import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@bagyo/ingest': fileURLToPath(
        new URL('../../packages/ingest/src/index.ts', import.meta.url),
      ),
      '@bagyo/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
      '@bagyo/parser': fileURLToPath(
        new URL('../../packages/parser/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
