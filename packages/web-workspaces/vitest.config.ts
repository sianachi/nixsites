// Test configuration for this package; mirrors the test block of apps/web/vite.config.ts.
// Not 5000 for testTimeout: page renders into jsdom under a loaded runner need the headroom (the
// app config says why). Node 25 defines a global localStorage that hides jsdom's, hence the flag.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['@nix/web-foundation/testing/setup'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    poolOptions: {
      forks: { execArgv: ['--no-experimental-webstorage'] },
      threads: { execArgv: ['--no-experimental-webstorage'] },
    },
    testTimeout: 15_000,
  },
});
