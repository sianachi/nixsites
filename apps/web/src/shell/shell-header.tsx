import { Icon, Menu, Text, chromeSurface, focusRing } from '@nix/ui';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import { type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';

import { TITLE_ROW_LEAD_ID, TITLE_ROW_TABS_ID } from '../tabs/title-row-slot';
import { shortcutFor } from '@nix/web-foundation/keyboard/shortcut-registry';
import { formatShortcut } from '@nix/web-foundation/lib/shortcuts';
import type { CurrentPrincipalState } from '@nix/web-platform/session/use-current-principal';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useWorkspaceMenuEntries } from '@nix/web-workspaces/workspaces/workspace-switcher';
import { NotificationBell } from './notifications/notification-bell';
import { ProfileMenu } from './profile-menu';

export interface ShellHeaderProps {
  readonly sidebarVisible: boolean;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly onToggleSidebar: () => void;
  /** The pinned Explorer's width, so the tabs start where the page does; null when it is not pinned. */
  readonly explorerWidth: number | null;
  /** Search, the bell and the profile, at the right end of the row. */
  readonly account: HeaderAccount;
}

export interface HeaderAccount {
  readonly principal: CurrentPrincipalState;
  readonly unreadNotifications: number;
  readonly onOpenSearch: () => void;
  readonly onOpenInbox: () => void;
}

const SEARCH_KEYS = shortcutFor('search').keys;

/**
 * The header as a desktop title bar, when the installed app draws its own.
 *
 * With `display_override: window-controls-overlay` in the manifest, an installed desktop app can
 * hand its title bar to the page: the system's window buttons float over the top-left or top-right
 * corner and the rest of the strip is ours. The header already is that strip, so in that mode it
 * takes the title bar's height, keeps clear of the window buttons on whichever side the platform
 * puts them, and becomes the handle the window is dragged by - everything interactive inside it
 * opting back out, or a click on Search would move the window instead.
 *
 * Only in that display mode: in a browser tab, or an installed window with an ordinary title bar,
 * none of these apply and the header is laid out exactly as before.
 */
// design-token-exempt: the title-bar geometry is the platform's, read from its environment values.
const TITLE_BAR_OVERLAY = [
  '[@media(display-mode:window-controls-overlay)]:[app-region:drag]',
  // Chromium has long read only the prefixed spelling; both, until it is certain it reads either.
  '[@media(display-mode:window-controls-overlay)]:[-webkit-app-region:drag]',
  '[@media(display-mode:window-controls-overlay)]:min-h-[env(titlebar-area-height,0px)]',
  '[@media(display-mode:window-controls-overlay)]:py-0!',
  '[@media(display-mode:window-controls-overlay)]:pl-[max(1rem,env(titlebar-area-x,0px))]!', // design-token-exempt: the platform's title-bar inset, floored at the header's own sm:px-4
  '[@media(display-mode:window-controls-overlay)]:pr-[max(1rem,calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)))]!', // design-token-exempt: the window buttons' width on the right, floored at the header's own sm:px-4
  '[@media(display-mode:window-controls-overlay)]:[&_:is(a,button,input,select,[role=button],[role=combobox],[tabindex])]:[app-region:no-drag]',
  '[@media(display-mode:window-controls-overlay)]:[&_:is(a,button,input,select,[role=button],[role=combobox],[tabindex])]:[-webkit-app-region:no-drag]',
].join(' ');

const TITLE_BUTTON = `mb-0.5 flex size-(--control-sm) shrink-0 items-center justify-center rounded-md text-muted any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg) hover:bg-foreground/7 hover:text-foreground ${focusRing}`;

/**
 * The title row: the explorer toggle, back and forward, and the first pane's tabs, all on the
 * sheet colour so the tabs rise out of it onto the page. Search, the bell, the profile menu and
 * Zen are not here: the first three are on the icon strip, Zen is in the note's menu and the
 * command palette.
 */
export function ShellHeader({
  sidebarVisible,
  sidebarToggleRef,
  onToggleSidebar,
  explorerWidth,
  account,
}: ShellHeaderProps): ReactNode {
  const navigate = useNavigate();
  const { workspace } = useWorkspace();
  const workspaceMenu = useWorkspaceMenuEntries();
  return (
    <header
      aria-label="Workspace controls"
      className={`flex min-w-0 shrink-0 items-end bg-surface px-2 pt-1.5 ${chromeSurface} ${TITLE_BAR_OVERLAY}`}
    >
      <div
        id={TITLE_ROW_LEAD_ID}
        className="flex shrink-0 items-end gap-1 pr-1"
        style={explorerWidth === null ? undefined : { width: `${String(explorerWidth)}px` }} // design-token-exempt: the Explorer's runtime width.
      >
        {/* Next to the tree it opens and closes, rather than inside it - a control that vanishes
          with the thing it controls cannot bring it back. */}
        <button
          ref={sidebarToggleRef}
          type="button"
          aria-label={sidebarVisible ? 'Hide the Explorer' : 'Show the Explorer'}
          aria-expanded={sidebarVisible}
          onClick={onToggleSidebar}
          className={TITLE_BUTTON}
        >
          <Icon icon={sidebarVisible ? PanelLeftClose : PanelLeftOpen} size="sm" />
        </button>

        <button
          type="button"
          aria-label="Back"
          onClick={() => {
            void navigate(-1);
          }}
          className={TITLE_BUTTON}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={() => {
            void navigate(1);
          }}
          className={TITLE_BUTTON}
        >
          <Icon icon={ChevronRight} size="sm" />
        </button>

        {/* The current workspace, and the way to another, beside the controls that move around it. */}
        <Menu label="Switch workspace" items={workspaceMenu.entries}>
          {(trigger) => (
            <button
              {...trigger}
              type="button"
              className={`mb-0.5 ml-1 flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-foreground hover:bg-foreground/7 ${focusRing}`}
            >
              <Text as="span" variant="bodySmall" truncate>
                {workspace.name}
              </Text>
              <Icon icon={ChevronDown} size="sm" className="shrink-0 text-muted" />
            </button>
          )}
        </Menu>
        {workspaceMenu.dialogs}
      </div>

      <div id={TITLE_ROW_TABS_ID} className="flex min-w-0 flex-1" />
      <div className="ml-2 flex shrink-0 items-center gap-1 self-center pb-1">
        <button
          type="button"
          onClick={account.onOpenSearch}
          aria-label="Search"
          className={`flex w-56 items-center gap-2 rounded-md bg-background px-3 py-1.5 text-xs text-muted hover:bg-foreground/7 max-lg:w-auto ${focusRing}`}
        >
          <Icon icon={Search} size="sm" />
          <span className="flex-1 text-left max-lg:sr-only">Search</span>
          {/* Shown rather than hidden in a tooltip: a shortcut nobody can discover goes unused. */}
          <kbd className="font-mono text-xs text-muted max-lg:hidden">
            {SEARCH_KEYS.map((keys) => formatShortcut(keys)).join(' ')}
          </kbd>
        </button>
        <NotificationBell unread={account.unreadNotifications} onClick={account.onOpenInbox} />
        <ProfileMenu principal={account.principal} />
      </div>
    </header>
  );
}
