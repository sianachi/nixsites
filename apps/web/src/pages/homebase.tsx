import { Blueprint, Icon, Text, cn, focusRing } from '@nix/ui';
import {
  CalendarClock,
  CalendarDays,
  Columns2,
  FilePlus,
  FileText,
  FolderInput,
  Grid3x3,
  LayoutTemplate,
  Settings,
  Shapes,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { NewItemDialog } from '../items/new-item-dialog';
import type { WorkspaceTree } from '../items/use-workspace-tree';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { recentItems } from '@nix/web-foundation/lib/recent-items';
import { useOpenItem } from '../tabs/use-open-item';
import { useTemplateLibrary } from '../templates/template-library-context';
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
}: {
  readonly tree: WorkspaceTree;
  readonly onImport: () => void;
}): ReactNode {
  const { workspaceId, workspace } = useWorkspace();
  const { openPreview } = useOpenItem();
  const navigate = useNavigate();
  const templateLibrary = useTemplateLibrary();
  const [choosingStructure, setChoosingStructure] = useState(false);
  const recents = useMemo(() => recentItems(workspaceId), [workspaceId]);

  const now = new Date();
  const home = `/w/${workspaceId}`;

  function createNote(): void {
    void tree.create(null, 'Untitled note').then((outcome) => {
      if (outcome.id !== null) openPreview(outcome.id);
      else
        publishNotice({
          key: 'new-note-failed',
          message: outcome.refusal ?? 'That could not be created.',
        });
    });
  }

  const actions: Action[] = [
    {
      key: 'note',
      label: tree.isCreating ? 'Creating…' : 'New note',
      detail: 'A blank page, opened at once',
      icon: FilePlus,
      onSelect: createNote,
    },
    {
      key: 'structured',
      label: 'Structured note',
      detail: 'Board, list, tracker or form',
      icon: Columns2,
      onSelect: () => {
        setChoosingStructure(true);
      },
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
      key: 'automations',
      label: 'Automations',
      detail: 'Rules that run on their own',
      icon: Zap,
      to: `${home}/automations`,
    },
    {
      key: 'settings',
      label: 'Settings',
      detail: 'This workspace and your account',
      icon: Settings,
      to: `${home}/settings`,
    },
  ];

  const start = (
    <section aria-labelledby="homebase-start" className="flex min-w-0 flex-col gap-3">
      <Text as="h2" variant="h6" tone="muted" id="homebase-start">
        Start something
      </Text>
      <ul className="grid grid-cols-2 gap-2 md:grid-cols-1">
        {actions.map((action, index) => (
          <li
            key={action.key}
            // Two across on a phone: New note takes a row, and so does a last tile left alone.
            className={
              index === 0 || (index === actions.length - 1 && index % 2 === 1)
                ? 'col-span-2 sm:col-span-1'
                : undefined
            }
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

  const recent = (
    <section aria-labelledby="homebase-recent" className="flex min-w-0 flex-col gap-3">
      <Text as="h2" variant="h6" tone="muted" id="homebase-recent">
        Recently viewed
      </Text>
      {recents.length === 0 ? (
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
          {recents.map((entry) => {
            const item = tree.find(entry.itemId);
            const parent = item?.parentId == null ? null : tree.find(item.parentId);
            const title = (item?.title ?? entry.title) || 'Untitled';
            return (
              <li key={entry.itemId} className="border-b border-divider">
                <button
                  type="button"
                  className={cn(
                    'flex min-h-(--control-lg) w-full min-w-0 items-center gap-3 rounded-sm px-2 text-left hover:bg-surface',
                    focusRing,
                  )}
                  onClick={() => {
                    openPreview(entry.itemId);
                  }}
                >
                  <Icon icon={iconForType(item?.type)} size="sm" className="shrink-0 text-muted" />
                  <Text as="span" variant="body" truncate className="min-w-0 flex-1">
                    {title}
                  </Text>
                  {parent == null ? null : (
                    <Text
                      as="span"
                      variant="note"
                      tone="muted"
                      truncate
                      className="max-w-40 shrink-0 max-sm:hidden"
                    >
                      {parent.title || 'Untitled'}
                    </Text>
                  )}
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
        <Text variant="kicker" tone="muted" truncate>
          {workspace.name}
        </Text>
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

      <div className="grid min-w-0 gap-10 md:grid-cols-3">
        <div className="min-w-0">{start}</div>
        <div className="min-w-0 md:col-span-2">{recent}</div>
      </div>

      {choosingStructure ? (
        <NewItemDialog
          mode={{ kind: 'structured' }}
          childDestination={null}
          templates={templateLibrary.templates}
          templateStatus={templateLibrary.status}
          onClose={() => {
            setChoosingStructure(false);
          }}
          onStartStructured={(parentId, recipe) => {
            const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
            void navigate(`${home}/new/${recipe}${search}`);
          }}
          // The structured mode offers neither a plain item nor an upload.
          onCreate={() => undefined}
          onUpload={() => undefined}
          onStartTemplate={(parentId, templateId) => {
            const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
            void navigate(`${home}/templates/${templateId}/create${search}`);
          }}
          onBrowseTemplates={() => {
            void navigate(`${home}/templates`);
          }}
        />
      ) : null}
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
