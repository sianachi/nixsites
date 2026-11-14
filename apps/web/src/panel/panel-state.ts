/** The event the open note's page answers by toggling its details panel (the panel state lives there). */
export const TOGGLE_ITEM_PANEL_EVENT = 'nix:toggle-item-panel';

/** Asks the open item's page to show its Site pane; the sidebar row menu uses it for items it is about to open. */
export const OPEN_SITE_PANE_EVENT = 'nix:open-site-pane';
let pendingSiteItem: string | null = null;

export function requestSitePane(itemId: string): void {
  pendingSiteItem = itemId;
  window.dispatchEvent(new Event(OPEN_SITE_PANE_EVENT));
}

/** True once for the item a request named, so a later visit does not reopen the pane. */
export function takeSitePaneRequest(itemId: string): boolean {
  if (pendingSiteItem !== itemId) return false;
  pendingSiteItem = null;
  return true;
}
