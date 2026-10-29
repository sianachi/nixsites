import { lazy } from 'react';

import { CUSTOM_VIEW_KIND } from './openui/custom-view-kind';
import { CHAT_VIEW_KIND } from './pets/chat/chat-view-kind';
import { STARTER_PROGRAM } from './openui/starter-program';
import { registerBuiltinViews } from '@nix/web-views/builtin-views';
import { provideProgramEditor } from '@nix/web-views/core/program-editor-slot';
import { registerViewKinds } from '@nix/web-views/core/view-kinds';

/**
 * Registers every view kind and the custom view's program editor, once, before anything renders.
 * The app, the test setup and Storybook all call this, so each draws the same kinds in the same
 * order.
 */
export function registerViews(): void {
  // Chat leads the picker: it registers ahead of the builtin kinds.
  registerViewKinds(CHAT_VIEW_KIND);
  registerBuiltinViews();
  registerViewKinds(CUSTOM_VIEW_KIND);
  // The program editor carries the OpenUI renderer, so it loads only when one is opened.
  provideProgramEditor(
    lazy(() =>
      import('./openui/program-editor').then((module) => ({ default: module.ProgramEditor })),
    ),
    STARTER_PROGRAM,
  );
}
