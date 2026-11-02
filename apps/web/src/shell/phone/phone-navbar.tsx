import { Icon, cn, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { PhoneMenu, type PhoneMenuProps } from './phone-menu';

export interface PhoneNavbarProps extends Omit<PhoneMenuProps, 'icon' | 'label' | 'className'> {
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
  creating,
  tabCount,
  onSearch,
  onCreate,
  onTabs,
  ...menu
}: PhoneNavbarProps): ReactNode {
  const navigate = useNavigate();
  // The entry the app was opened on has React Router's 'default' key; going back from it would
  // leave the app (to a sign-in redirect or the server picker), so Back is off there.
  const atStart = useLocation().key === 'default';
  return (
    // design-token-exempt: device safe-area inset keeps the pill above the home indicator.
    <nav
      aria-label="Mobile navigation"
      className="px-3 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-1"
    >
      <div className="flex items-center justify-between rounded-full border border-divider bg-background/75 px-2 shadow-lg backdrop-blur-md">
        <button
          type="button"
          aria-label="Back"
          className={button}
          disabled={atStart}
          onClick={() => {
            void navigate(-1);
          }}
        >
          <Icon icon={ChevronLeft} size="sm" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          className={button}
          onClick={() => {
            void navigate(1);
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
          <span className="flex size-6 items-center justify-center rounded-md border-2 border-current text-xs font-semibold">
            {tabCount}
          </span>
        </button>
        <PhoneMenu {...menu} />
      </div>
    </nav>
  );
}
