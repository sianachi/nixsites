import { Icon, Text, cn, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

export interface PhoneNavbarProps {
  readonly hidden: boolean;
  readonly explorerOpen: boolean;
  readonly onCloseExplorer: () => void;
  readonly menu: ReactNode;
  readonly creating: boolean;
  readonly tabCount: number;
  readonly onSearch: () => void;
  readonly onCreate: () => void;
  readonly onTabs: () => void;
}

const button = cn(
  'flex size-(--control-lg) shrink-0 items-center justify-center rounded-full text-foreground disabled:text-muted',
  focusRing,
);

/** Obsidian's floating bottom pill: history, find, new, tabs and a menu for the rest. */
export function PhoneNavbar({
  hidden,
  explorerOpen,
  onCloseExplorer,
  creating,
  tabCount,
  onSearch,
  onCreate,
  onTabs,
  menu,
}: PhoneNavbarProps): ReactNode {
  const navigate = useNavigate();
  // The entry the app was opened on has React Router's 'default' key; going back from it would
  // leave the app (to a sign-in redirect or the server picker), so Back is off there.
  const atStart = useLocation().key === 'default';
  function moveHistory(delta: -1 | 1): void {
    // The drawer already owns a history entry. Close it before walking the page history.
    if (explorerOpen) onCloseExplorer();
    else void navigate(delta);
  }
  return (
    // design-token-exempt: device safe-area inset keeps the pill above the home indicator.
    <nav
      id="phone-navigation"
      hidden={hidden}
      aria-label="Mobile navigation"
      className="px-3 pb-[max(env(safe-area-inset-bottom),var(--spacing)*2)] pt-1"
    >
      <div className="mx-auto flex max-w-[520px] items-center justify-between rounded-full border border-divider bg-background/75 px-2 shadow-lg backdrop-blur-md">
        <button
          type="button"
          aria-label="Back"
          className={button}
          disabled={atStart && !explorerOpen}
          onClick={() => {
            moveHistory(-1);
          }}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          className={button}
          onClick={() => {
            moveHistory(1);
          }}
        >
          <Icon icon={ChevronRight} size="sm" />
        </button>
        <button type="button" aria-label="Find" className={button} onClick={onSearch}>
          <Icon icon={Search} size="sm" />
        </button>
        <button
          type="button"
          aria-label="New note"
          disabled={creating}
          className={button}
          onClick={onCreate}
        >
          <Icon icon={Plus} size="sm" />
        </button>
        <button
          type="button"
          aria-label={`Open tabs, ${String(tabCount)} open`}
          className={button}
          onClick={onTabs}
        >
          <Text
            as="span"
            variant="caption"
            className="flex size-6 items-center justify-center rounded-md border-2 border-current"
          >
            {tabCount}
          </Text>
        </button>
        {menu}
      </div>
    </nav>
  );
}
