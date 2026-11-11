import { z } from 'zod';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';

/** Dispatched by a tab strip's "+"; the shell answers by opening the palette in new-tab mode. */
export const OPEN_NEW_TAB_PICKER_EVENT = 'nix:open-new-tab-picker';

/** Dispatched by the portrait tablet's tab-count button; the shell opens the tab switcher grid. */
export const OPEN_TAB_SWITCHER_EVENT = 'nix:open-tab-switcher';

const creationTabState = z.object({ newTab: z.literal(true), previousItemId: z.uuid().nullable() });

export function pinCreatedTab(state: unknown, itemId: string): void {
  const parsed = creationTabState.safeParse(state);
  if (!parsed.success) return;
  const tabs = useTabStore.getState();
  if (parsed.data.previousItemId !== null) tabs.tabPinned(0, parsed.data.previousItemId);
  tabs.itemOpenedAlone(itemId, true);
}
