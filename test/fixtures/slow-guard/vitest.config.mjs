import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A run of one slow test with the real slow-test guard (test/slow-guard.test.mjs).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['*.fixture.mjs'],
    environment: 'node',
    setupFiles: ['../../slow-guard.mjs'],
    retry: 0,
  },
});
