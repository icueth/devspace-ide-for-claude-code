import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Matches the path aliases in tsconfig.json so tests can import via
// @main/@shared/@renderer/@preload like the production code.
export default defineConfig({
  resolve: {
    alias: {
      '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@preload': fileURLToPath(new URL('./src/preload', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests touch real fs via mkdtemp — keep them serial so the
    // module-level state Map in ChatTranscript doesn't get clobbered
    // across files. Each test uses a unique project path so the Map is
    // additive-safe, but better-safe-than-sorry.
    fileParallelism: false,
  },
});
