import { CUSTOM_VIEW_KIND } from './openui/custom-view-kind';
import { CHAT_VIEW_KIND } from './pets/chat/chat-view-kind';
import { registerBuiltinViews } from '@nix/web-views/builtin-views';
import { registerViewKinds } from '@nix/web-views/core/view-kinds';

/**
 * Registers every view kind, once, before anything renders.
 * The app, the test setup and Storybook all call this, so each draws the same kinds in the same
 * order.
 */
export function registerViews(): void {
  // Chat leads the picker: it registers ahead of the builtin kinds.
  registerViewKinds(CHAT_VIEW_KIND);
  registerBuiltinViews();
  registerViewKinds(CUSTOM_VIEW_KIND);
}
