import { Icon, cn, focusRing } from '@nix/ui';
import { PanelLeft, PanelRight } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import type { CurrentPrincipalState } from '@nix/web-platform/session/use-current-principal';

import { ProfileMenu } from '../profile-menu';

/** The event the open note's page answers by toggling its details panel (the panel state lives there). */
export const TOGGLE_ITEM_PANEL_EVENT = 'nix:toggle-item-panel';

export interface PhoneTopRowProps {
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly sidebarVisible: boolean;
  /** Whether an item is open, so there are details to show. */
  readonly hasItem: boolean;
  readonly onToggleSidebar: () => void;
  /** The signed-in person: their menu (account, workspaces, sign out) sits where "..." was. */
  readonly principal: CurrentPrincipalState;
}

const surface = 'border border-divider bg-background/75 shadow-md backdrop-blur-md';
const round = cn(
  'flex size-(--control-lg) items-center justify-center rounded-full text-foreground',
  focusRing,
);

/** Obsidian's floating top row, in place of the header: the drawer on the left, details and the profile menu on the right. */
export function PhoneTopRow({
  sidebarToggleRef,
  sidebarVisible,
  hasItem,
  onToggleSidebar,
  principal,
}: PhoneTopRowProps): ReactNode {
  return (
    // design-token-exempt: device safe-area inset keeps the row below the status bar.
    <header
      aria-label="Workspace controls"
      className="flex items-center justify-between px-3 pb-1 pt-[max(env(safe-area-inset-top),0.5rem)]"
    >
      <button
        ref={sidebarToggleRef}
        type="button"
        aria-label={sidebarVisible ? 'Hide the Explorer' : 'Show the Explorer'}
        aria-expanded={sidebarVisible}
        onClick={onToggleSidebar}
        className={cn(round, surface)}
      >
        <Icon icon={PanelLeft} size="sm" />
      </button>
      <div className={cn('flex items-center rounded-full px-1', surface)}>
        {hasItem ? (
          <button
            type="button"
            aria-label="Open details"
            className={round}
            onClick={() => window.dispatchEvent(new Event(TOGGLE_ITEM_PANEL_EVENT))}
          >
            <Icon icon={PanelRight} size="sm" />
          </button>
        ) : null}
        <ProfileMenu principal={principal} />
      </div>
    </header>
  );
}
