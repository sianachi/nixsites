import { Blueprint, Button, Icon, Text, cn, focusRing, useUndo } from '@nix/ui';
import {
  CalendarClock,
  CalendarDays,
  Columns2,
  FilePlus,
  FileText,
  FolderInput,
  FolderTree,
  Grid3x3,
  LayoutTemplate,
  Settings,
  Shapes,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { recentItems } from '@nix/web-foundation/lib/recent-items';
import { useOpenItem } from '../tabs/use-open-item';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

/** The ISO 8601 week number of a local date: weeks start on Monday, week 1 holds 4 January. */
export function isoWeek(date: Date): number {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  return Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function iconForType(type: string | undefined): LucideIcon {
  if (type === 'canvas') return Shapes;
  if (type === 'spreadsheet') return Grid3x3;
  return FileText;
}

interface Action {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: LucideIcon;
  readonly to?: string;
  readonly onSelect?: () => void;
}

/**
 * The workspace's start screen, shown while no item is open: a greeting, the actions people start
 * a session with beside the items they opened last on this browser. One column on a phone.
 */
export function Homebase({
  tree,
  onImport,
  onOpenStructured,
  onExplore,
}: {
  readonly tree: WorkspaceTree;
  readonly onOpenStructured: () => void;
  readonly onImport: () => void;
  readonly onExplore: () => void;
}): ReactNode {
  const { workspaceId, workspace } = useWorkspace();
  const { openPreview } = useOpenItem();
  const navigate = useNavigate();
  const undo = useUndo();
  const recents = useMemo(() => recentItems(workspaceId), [workspaceId]);

  const now = new Date();
  const home = `/w/${workspaceId}`;

  function createNote(): void {
    void tree.create(null, 'Untitled note').then((outcome) => {
      if (outcome.id !== null) {
        const createdId = outcome.id;
        openPreview(createdId);
        undo.push('Created "Untitled note"', async () => {
          const removed = await tree.remove(createdId);
          if (removed.refusal === null) void navigate(home);
          else publishNotice({ key: 'new-note-undo-failed', message: removed.refusal });
        });
      } else
        publishNotice({
          key: 'new-note-failed',
          message: outcome.refusal ?? 'That could not be created.',
        });
    });
  }

  const quick: Action[] = [
    {
      key: 'note',
      label: tree.isCreating ? 'Creating…' : 'New note',
      detail: 'A blank page, opened at once',
      icon: FilePlus,
      onSelect: createNote,
    },
    ...(workspace.canUseDailyNotes
      ? [
          {
            key: 'daily',
            label: "Today's note",
            detail: `The page for ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }).format(now)}`,
            icon: CalendarClock,
            to: `${home}/daily`,
          },
        ]
      : []),
  ];
  const more: Action[] = [
    {
      key: 'structured',
      label: 'New list, board or tracker',
      detail: 'Choose a layout for tasks, habits or forms',
      icon: Columns2,
      onSelect: onOpenStructured,
    },
    {
      key: 'calendar',
      label: 'Calendar',
      detail: 'Events and dated items',
      icon: CalendarDays,
      to: `${home}/calendar`,
    },
    {
      key: 'templates',
      label: 'Templates',
      detail: 'Start from a saved structure',
      icon: LayoutTemplate,
      to: `${home}/templates`,
    },
    {
      key: 'import',
      label: 'Import',
      detail: 'Notes, documents or an archive',
      icon: FolderInput,
      onSelect: onImport,
    },
    {
      key: 'settings',
      label: 'Settings',
      detail: 'This workspace and your account',
      icon: Settings,
      to: `${home}/settings`,
    },
  ];

  const [latest, ...earlier] = recents;
  const latestItem = latest === undefined ? undefined : tree.find(latest.itemId);
  const latestParent = latestItem?.parentId == null ? null : tree.find(latestItem.parentId);

  const start = (
    <section aria-labelledby="homebase-start" className="flex min-w-0 flex-col gap-3">
      <Text as="h2" variant="h6" tone="muted" id="homebase-start" className="sr-only">
        Start something
      </Text>
      <ul
        className={cn(
          'grid grid-cols-2 gap-3',
          latest === undefined ? 'md:grid-cols-2' : 'md:grid-cols-[2fr_1fr_1fr]',
        )}
      >
        {latest === undefined ? null : (
          <li className="col-span-2 md:col-span-1">
            <button
              type="button"
              className={cn(
                'flex h-full min-h-24 w-full min-w-0 flex-col justify-between gap-2 rounded-md border border-divider bg-surface p-3 text-left',
                'hover:bg-divider active:scale-[0.97] motion-reduce:active:scale-100',
                focusRing,
              )}
              onClick={() => {
                openPreview(latest.itemId);
              }}
            >
              <Text as="span" variant="kicker" className="text-accent-text">
                Continue
              </Text>
              <Text
                as="span"
                variant="h5"
                className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]"
              >
                {(latestItem?.title ?? latest.title) || 'Untitled'}
              </Text>
              <Text as="span" variant="note" tone="muted" truncate>
                {latestParent == null ? 'Last opened' : latestParent.title || 'Untitled'}
              </Text>
            </button>
          </li>
        )}
        {quick.map((action, index) => (
          <li
            key={action.key}
            className={index === 0 && quick.length === 1 ? 'col-span-2 md:col-span-1' : undefined}
          >
            <ActionTile
              action={action}
              primary={index === 0}
              disabled={index === 0 && (tree.status !== 'ready' || tree.isCreating)}
            />
          </li>
        ))}
      </ul>
    </section>
  );

  const moreActions = (
    <section aria-labelledby="homebase-more" className="flex min-w-0 flex-col gap-3">
      <Text as="h2" variant="h6" tone="muted" id="homebase-more">
        More
      </Text>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-1">
        {more.map((action) => (
          <li key={action.key}>
            <ActionTile action={action} primary={false} disabled={false} />
          </li>
        ))}
      </ul>
    </section>
  );

  const recent = (
    <section aria-labelledby="homebase-recent" className="flex min-w-0 flex-col gap-3">
      <Text as="h2" variant="h6" tone="muted" id="homebase-recent">
        Recently viewed
      </Text>
      {latest === undefined ? (
        <Blueprint className="flex flex-col gap-1 p-4">
          <Text as="p" variant="body">
            Notes you open show up here.
          </Text>
          <Text as="p" variant="note" tone="muted">
            Start with a new note, or pick one in the Explorer.
          </Text>
        </Blueprint>
      ) : (
        <ul className="border-t border-divider">
          {earlier.slice(0, 8).map((entry) => {
            const item = tree.find(entry.itemId);
            const parent = item?.parentId == null ? null : tree.find(item.parentId);
            const title = (item?.title ?? entry.title) || 'Untitled';
            return (
              <li key={entry.itemId} className="border-b border-divider">
                <button
                  type="button"
                  className={cn(
                    'flex min-h-(--control-lg) w-full min-w-0 items-center gap-3 rounded-sm px-2 py-1 text-left hover:bg-surface',
                    'active:scale-[0.97] motion-reduce:active:scale-100',
                    focusRing,
                  )}
                  onClick={() => {
                    openPreview(entry.itemId);
                  }}
                >
                  <Icon icon={iconForType(item?.type)} size="sm" className="shrink-0 text-muted" />
                  <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:gap-3">
                    <Text as="span" variant="body" truncate className="min-w-0 flex-1">
                      {title}
                    </Text>
                    {parent == null ? null : (
                      <Text
                        as="span"
                        variant="note"
                        tone="muted"
                        truncate
                        className="min-w-0 sm:max-w-40 sm:shrink-0"
                      >
                        {parent.title || 'Untitled'}
                      </Text>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-10 px-4 py-8 sm:px-8 sm:py-14">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <Text variant="kicker" tone="muted" truncate>
            {workspace.name}
          </Text>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" onClick={onExplore}>
              <Icon icon={FolderTree} size="sm" />
              Explore
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                void navigate(`${home}/workspaces`);
              }}
            >
              Workspaces
            </Button>
          </div>
        </div>
        <Text as="h1" variant="h1" className="min-w-0">
          {greeting(now.getHours())}
        </Text>
        {/* The date as a notebook page's header rule, the week number where a page number sits. */}
        <div className="flex min-w-0 items-center gap-3">
          <Text as="p" variant="body" tone="muted" className="shrink-0">
            {new Intl.DateTimeFormat(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(now)}
          </Text>
          <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-divider" />
          <Text as="p" variant="kicker" tone="muted" className="shrink-0">
            Week {isoWeek(now)}
          </Text>
        </div>
      </header>

      {start}

      <div className="grid min-w-0 gap-10 md:grid-cols-[2fr_1fr]">
        {earlier.length > 0 || latest === undefined ? (
          <div className="min-w-0">{recent}</div>
        ) : null}
        <div className="min-w-0 md:col-start-2">{moreActions}</div>
      </div>
    </div>
  );
}

function ActionTile({
  action,
  primary,
  disabled,
}: {
  readonly action: Action;
  readonly primary: boolean;
  readonly disabled: boolean;
}): ReactNode {
  const className = cn(
    'flex h-full min-h-24 w-full min-w-0 flex-col gap-2 rounded-md border p-3 text-left',
    'md:min-h-0 md:flex-row md:items-center md:gap-4 md:px-4',
    primary
      ? 'max-sm:min-h-0 max-sm:flex-row max-sm:items-center border-accent-fill bg-accent-fill hover:bg-accent-fill-hover disabled:opacity-45'
      : 'border-divider hover:bg-surface',
    'active:scale-[0.97] motion-reduce:active:scale-100',
    focusRing,
  );
  const body = (
    <>
      <Icon
        icon={action.icon}
        size="md"
        className={cn('shrink-0', primary ? 'text-background' : 'text-accent-text')}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <Text as="span" variant="h5" className={primary ? 'text-background' : ''}>
          {action.label}
        </Text>
        <Text
          as="span"
          variant="note"
          tone={primary ? 'default' : 'muted'}
          className={primary ? 'text-background' : ''}
        >
          {action.detail}
        </Text>
      </span>
    </>
  );
  return action.to === undefined ? (
    <button type="button" className={className} disabled={disabled} onClick={action.onSelect}>
      {body}
    </button>
  ) : (
    <Link to={action.to} className={className}>
      {body}
    </Link>
  );
}
