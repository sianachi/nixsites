// The pets layer of the web test setup: the editor base plus every view kind, registered once per
// test file in the order register-views.ts uses in the app (chat leads the picker, custom last).
// Imported in beforeAll rather than statically so it loads after the test file's imports, and a
// vi.mock of any view module applies to it as well.
import '@nix/web-editor/testing/setup';
import { lazy } from 'react';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const { VIEW_KINDS, registerViewKinds } = await import('@nix/web-views/core/view-kinds');
  if (VIEW_KINDS.length > 0) return;
  const { registerBuiltinViews } = await import('@nix/web-views/builtin-views');
  const { provideProgramEditor } = await import('@nix/web-views/core/program-editor-slot');
  const { CHAT_VIEW_KIND } = await import('../pets/chat/chat-view-kind');
  const { CUSTOM_VIEW_KIND } = await import('../openui/custom-view-kind');
  const { STARTER_PROGRAM } = await import('../openui/starter-program');
  registerViewKinds(CHAT_VIEW_KIND);
  registerBuiltinViews();
  registerViewKinds(CUSTOM_VIEW_KIND);
  provideProgramEditor(
    lazy(() =>
      import('../openui/program-editor').then((module) => ({ default: module.ProgramEditor })),
    ),
    STARTER_PROGRAM,
  );
});
