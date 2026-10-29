import { Icon, Text, chromeSurface, cn, focusRing } from '@nix/ui';
import { Bell, CalendarDays, FolderTree, PawPrint, Plus, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

export function MobileNavigation({
  workspaceId,
  treeOpen,
  creating,
  unreadNotifications,
  pet,
  onTree,
  onSearch,
  onCreate,
  onOpenInbox,
}: {
  readonly workspaceId: string;
  readonly treeOpen: boolean;
  readonly creating: boolean;
  readonly unreadNotifications: number;
  /** The pet page entry, or null while this width offers none. `attention` is what it is waiting
   * on, in words. */
  readonly pet: { readonly label: string; readonly attention: string | null } | null;
  readonly onTree: () => void;
  readonly onSearch: () => void;
  readonly onCreate: () => void;
  readonly onOpenInbox: () => void;
}): ReactNode {
  const control = `flex min-h-(--control-lg) min-w-0 flex-1 flex-col items-center justify-center gap-1 sm:flex-row sm:gap-2 rounded-md px-1 py-2 hover:bg-surface ${focusRing}`;
  // A tab bar's selected item is told apart by a fill and ink, the others stay muted - glyph and
  // label together, so the label never reads as selected while its glyph does not.
  const tone = (active: boolean): string => (active ? 'bg-surface text-foreground' : 'text-muted');
  return (
    // design-token-exempt: device safe-area inset keeps navigation above the home indicator.
    <nav
      aria-label="Mobile navigation"
      className={`flex shrink-0 items-center gap-1 border-t border-divider bg-background px-2 pb-[env(safe-area-inset-bottom)] ${chromeSurface}`}
    >
      <button
        type="button"
        className={`${control} ${tone(treeOpen)}`}
        aria-expanded={treeOpen}
        onClick={onTree}
      >
        <Icon icon={FolderTree} size="sm" />
        <Text variant="caption" tone={treeOpen ? 'default' : 'muted'}>
          Explorer
        </Text>
      </button>
      <button type="button" className={`${control} ${tone(false)}`} onClick={onSearch}>
        <Icon icon={Search} size="sm" />
        <Text variant="caption" tone="muted">
          Find
        </Text>
      </button>
      <NavLink
        to={`/w/${workspaceId}/calendar`}
        className={({ isActive }) => `${control} ${tone(isActive)}`}
      >
        {({ isActive }) => (
          <>
            <Icon icon={CalendarDays} size="sm" />
            <Text variant="caption" tone={isActive ? 'default' : 'muted'}>
              Calendar
            </Text>
          </>
        )}
      </NavLink>
      <button type="button" className={`relative ${control} ${tone(false)}`} onClick={onOpenInbox}>
        <span className="relative">
          <Icon icon={Bell} size="sm" />
          {unreadNotifications > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 size-2 rounded-full bg-accent-fill"
            />
          ) : null}
        </span>
        <Text variant="caption" tone="muted">
          Inbox
          {unreadNotifications > 0 ? (
            <span className="sr-only">, {unreadNotifications} unread</span>
          ) : null}
        </Text>
      </button>
      {pet ? (
        // Icon only: a sixth labelled item would not keep a readable label at 390px. The name is
        // the accessible name, so the pet is still announced by name.
        <NavLink
          to={`/w/${workspaceId}/pet`}
          className={({ isActive }) => `${control} flex-none w-(--control-lg) ${tone(isActive)}`}
        >
          <span className="relative">
            <Icon icon={PawPrint} size="sm" />
            {pet.attention !== null ? (
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 size-2 rounded-full bg-accent-fill"
              />
            ) : null}
          </span>
          <span className="sr-only">
            {pet.label}
            {pet.attention !== null ? `, ${pet.attention}` : ''}
          </span>
        </NavLink>
      ) : null}
      <button
        type="button"
        className={cn(
          control,
          'rounded-md bg-accent-fill text-background hover:bg-accent-fill-hover',
        )}
        disabled={creating}
        onClick={onCreate}
      >
        <Icon icon={Plus} size="sm" className="text-background" />
        <Text variant="caption" className="text-background">
          {creating ? 'Creating…' : 'New note'}
        </Text>
      </button>
    </nav>
  );
}
