// The pets layer of the web test setup: the editor base plus every view kind, registered once per
// test file by the same bootstrap the app runs. Imported in beforeAll rather than statically so it
// loads after the test file's imports, and a vi.mock of any view module applies to it as well.
import '@nix/web-editor/testing/setup';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const { VIEW_KINDS } = await import('@nix/web-views/core/view-kinds');
  if (VIEW_KINDS.length === 0) (await import('../register-views')).registerViews();
});
