import { Icon, Menu, cn, focusRing, type MenuEntry } from '@nix/ui';
import {
  Bell,
  CalendarDays,
  FolderInput,
  Layers,
  Maximize2,
  Menu as MenuIcon,
  PawPrint,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { toggleZenMode } from '@nix/web-foundation/lib/zen-mode';

export interface PhoneMenuProps {
  readonly workspaceId: string;
  readonly unreadNotifications: number;
  readonly pet: { readonly label: string; readonly attention: string | null } | null;
  readonly onOpenInbox: () => void;
  readonly onImport: () => void;
  /** The trigger's glyph and name; the navbar's menu and the top row's "..." share the entries. */
  readonly icon?: LucideIcon;
  readonly label?: string;
  readonly className?: string;
}

/** Calendar, Inbox, Pet, Workspaces, Settings, Import and Zen: what the phone's bottom bar has no room for. */
export function PhoneMenu({
  workspaceId,
  unreadNotifications,
  pet,
  onOpenInbox,
  onImport,
  icon = MenuIcon,
  label = 'Menu',
  className,
}: PhoneMenuProps): ReactNode {
  const navigate = useNavigate();
  const go = (path: string) => (): void => {
    void navigate(`/w/${workspaceId}${path}`);
  };
  const unread = unreadNotifications > 0;
  const items: MenuEntry[] = [
    { label: 'Calendar', icon: CalendarDays, onSelect: go('/calendar') },
    {
      label: unread ? `Inbox, ${String(unreadNotifications)} unread` : 'Inbox',
      icon: Bell,
      onSelect: onOpenInbox,
    },
    ...(pet
      ? [
          {
            label: pet.attention === null ? pet.label : `${pet.label}, ${pet.attention}`,
            icon: PawPrint,
            onSelect: go('/pet'),
          },
        ]
      : []),
    { label: 'Workspaces', icon: Layers, onSelect: go('/workspaces') },
    { label: 'Settings', icon: Settings, onSelect: go('/settings') },
    { label: 'Import', icon: FolderInput, onSelect: onImport },
    { label: 'Enter Zen mode', icon: Maximize2, onSelect: toggleZenMode },
  ];
  return (
    <Menu label={label} items={items}>
      {(trigger) => (
        <button
          {...trigger}
          aria-label={unread ? `${label}, ${String(unreadNotifications)} unread` : label}
          className={cn(
            'relative flex size-(--control-lg) shrink-0 items-center justify-center rounded-full text-foreground',
            focusRing,
            className,
          )}
        >
          <Icon icon={icon} size="sm" />
          {unread ? (
            <span
              aria-hidden="true"
              className="absolute right-2 top-2 size-2 rounded-full bg-accent-fill"
            />
          ) : null}
        </button>
      )}
    </Menu>
  );
}
