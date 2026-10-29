// The views layer of the web test setup: the editor base plus the built-in view kinds, registered
// once per test file. Chat and custom views register from the app, so tests that need them stay in
// apps/web. Imported in beforeAll rather than statically so it loads after the test file's imports,
// and a vi.mock of any view module applies to it as well.
import '@nix/web-editor/testing/setup';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const { VIEW_KINDS } = await import('../core/view-kinds');
  if (VIEW_KINDS.length === 0) {
    (await import('../builtin-views')).registerBuiltinViews();
  }
});
