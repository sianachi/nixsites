import { fileURLToPath } from 'node:url';

// Runs packages/sync-sqlite's own suites with the desktop store behind the driver (under Electron's
// Node, see `test:mirror`). Two tests check the file at the path they chose; the store names its own
// file, and its wipe is covered in test/store.test.mjs.
export default {
  root: fileURLToPath(new URL('../../packages/sync-sqlite', import.meta.url)),
  resolve: {
    alias: [
      {
        find: /^\.\/testing\/node-driver\.js$/,
        replacement: fileURLToPath(new URL('./test/mirror/desktop-driver.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/mirror.test.ts', 'src/engine.test.ts'],
    testNamePattern: '^(?!.*(removes only the revoked workspace|deletes the account SQLite files))',
  },
};
