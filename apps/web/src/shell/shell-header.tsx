import { Icon, chromeSurface, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';

import { TITLE_ROW_TABS_ID } from '../tabs/title-row-slot';

export interface ShellHeaderProps {
  readonly sidebarVisible: boolean;
  readonly sidebarToggleRef: RefObject<HTMLButtonElement | null>;
  readonly onToggleSidebar: () => void;
}

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
}: ShellHeaderProps): ReactNode {
  const navigate = useNavigate();
  return (
    <header
      aria-label="Workspace controls"
      className={`flex min-w-0 shrink-0 items-end gap-1 bg-surface px-2 pt-1.5 ${chromeSurface} ${TITLE_BAR_OVERLAY}`}
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

      <div id={TITLE_ROW_TABS_ID} className="ml-1 flex min-w-0 flex-1" />
    </header>
  );
}
