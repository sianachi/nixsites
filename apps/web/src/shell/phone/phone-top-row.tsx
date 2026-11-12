import { Icon, cn, focusRing } from '@nix/ui';
import { PanelBottomClose, PanelBottomOpen, PanelLeft, PanelRight } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';

import { TOGGLE_ITEM_PANEL_EVENT } from '../../panel/panel-state';
import { WorkspaceHomeLink } from '../workspace-home-link';

export interface PhoneTopRowProps {
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly sidebarVisible: boolean;
  readonly homePath: string;
  readonly homeCurrent: boolean;
  readonly onHome: () => void;
  readonly navigationHidden: boolean;
  readonly onToggleNavigation: () => void;
  /** Whether an item is open, so there are details to show. */
  readonly hasItem: boolean;
  readonly onToggleSidebar: () => void;
  readonly profile: ReactNode;
}

const surface = 'border border-divider bg-background/75 shadow-md backdrop-blur-md';
const round = cn(
  'flex size-(--control-lg) items-center justify-center rounded-full text-foreground',
  focusRing,
);

/** Phone workspace controls: Explorer and Home on the left, details and profile on the right. */
export function PhoneTopRow({
  sidebarToggleRef,
  sidebarVisible,
  homePath,
  homeCurrent,
  onHome,
  navigationHidden,
  onToggleNavigation,
  hasItem,
  onToggleSidebar,
  profile,
}: PhoneTopRowProps): ReactNode {
  const navigationLabel = navigationHidden ? 'Show navigation bar' : 'Hide navigation bar';
  return (
    // design-token-exempt: device safe-area inset keeps the row below the status bar.
    <header
      aria-label="Workspace controls"
      className="flex items-center justify-between px-3 pb-1 pt-[max(env(safe-area-inset-top),var(--spacing)*2)]"
    >
      <div className="flex shrink-0 items-center gap-2">
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
        <WorkspaceHomeLink
          to={homePath}
          current={homeCurrent}
          onActivate={onHome}
          className={cn(round, surface, 'hover:bg-surface active:bg-foreground/10')}
        />
        <button
          type="button"
          aria-label={navigationLabel}
          title={navigationLabel}
          aria-controls="phone-navigation"
          aria-expanded={!navigationHidden}
          onClick={onToggleNavigation}
          className={cn(round, surface, 'hover:bg-surface active:bg-foreground/10')}
        >
          <Icon icon={navigationHidden ? PanelBottomOpen : PanelBottomClose} size="sm" />
        </button>
      </div>
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
        {profile}
      </div>
    </header>
  );
}
