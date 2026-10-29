import { lazy } from 'react';

import { CUSTOM_VIEW_KIND } from './openui/custom-view-kind';
import { STARTER_PROGRAM } from './openui/starter-program';
import { registerBuiltinViews } from './views/builtin-views';
import { provideProgramEditor } from './views/core/program-editor-slot';
import { registerViewKinds } from './views/core/view-kinds';

/**
 * Registers every view kind and the custom view's program editor, once, before anything renders.
 * The app, the test setup and Storybook all call this, so each draws the same kinds in the same
 * order.
 */
export function registerViews(): void {
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
