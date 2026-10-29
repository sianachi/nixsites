// Test configuration for this package; mirrors the test block of apps/web/vite.config.ts.
// Not 5000 for testTimeout: page renders into jsdom under a loaded runner need the headroom (the
// app config says why). Node 25 defines a global localStorage that hides jsdom's, hence the flag.
import { createRequire } from 'node:module';

import { defineConfig } from 'vitest/config';

// Excalidraw's published bundle imports roughjs without its file extension; Node (used by Vitest)
// rejects that, so resolve it through Excalidraw's own entry as apps/web does.
const requireFromExcalidraw = createRequire(
  createRequire(import.meta.url).resolve('@excalidraw/excalidraw'),
);

export default defineConfig({
  resolve: {
    alias: { 'roughjs/bin/rough': requireFromExcalidraw.resolve('roughjs/bin/rough.js') },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/testing/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
      threads: { execArgv: ['--no-experimental-webstorage'] },
    },
    server: { deps: { inline: ['@excalidraw/excalidraw', 'roughjs'] } },
    testTimeout: 15_000,
  },
});
