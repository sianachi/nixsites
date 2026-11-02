/**
 * Whether the item settings panel is open.
 *
 * Remembered the same way the workspace tree's collapse is, and deliberately not in the URL: it
 * describes how one person's window is arranged rather than what is being looked at, so sending
 * somebody a link should not open a panel on their screen.
 *
 * Closed is the default, because the panel is for configuring an item rather than for reading one,
 * and most visits are reading.
 */

export const STORAGE_KEY = 'nix.item-panel';

const OPEN = 'open';

export function readPanelOpen(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === OPEN;
  } catch {
    // Private browsing, or a policy that blocks storage. A panel that forgets is a small loss.
    return false;
  }
}

export function storePanelOpen(storage: Storage | undefined, open: boolean): void {
  try {
    if (open) {
      storage?.setItem(STORAGE_KEY, OPEN);
      return;
    }

    // Closed is the default, and absent already means it. A second spelling would leave a later
    // reader unable to tell "never chosen" from "chose the default".
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do and nothing worth failing over.
  }
}

/** The event the open note's page answers by toggling its details panel (the panel state lives there). */
export const TOGGLE_ITEM_PANEL_EVENT = 'nix:toggle-item-panel';
