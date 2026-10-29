import { beforeAll } from 'vitest';

// The app's own bootstrap, once per test file. Imported in beforeAll rather than statically so it
// loads after the test file's imports, and a vi.mock of any view module applies to it as well. A
// test file that imports app.tsx has already run it there.
beforeAll(async () => {
  const { VIEW_KINDS } = await import('@nix/web-views/core/view-kinds');
  if (VIEW_KINDS.length === 0) {
    (await import('@nix/web-pets/register-views')).registerViews();
  }
});
