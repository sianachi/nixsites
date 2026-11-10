import {
  Button,
  Dialog,
  Icon,
  Input,
  Menu,
  Select,
  Text,
  focusRing,
  useFlash,
  useUndo,
  type MenuEntry,
} from '@nix/ui';
import {
  Archive,
  Check,
  ChevronDown,
  FolderClosed,
  Layers,
  Pin,
  PinOff,
  Plus,
  Settings,
} from 'lucide-react';
import type { Workspace, WorkspaceArrangementInput } from '@nix/api-client';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router';

import { addGroup, arrangeWorkspaces, assignToGroup, removeGroup, togglePin } from './arrangement';
import { CreateWorkspaceForm } from './settings/create-workspace-form';
import { readRecentWorkspaceIds } from './last-workspace';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { useWorkspace } from './workspace-context';
import { WorkspaceGroupsSection } from './workspace-groups-section';
import { WorkspaceLockMark } from './workspace-lock-mark';

/**
 * The workspace switcher is also the workspace index: every accessible workspace has a direct
 * route to its content and its management page. Switching always starts at a workspace root, so
 * neither an item nor a pane from one workspace can leak into another by way of the address bar.
 *
 * Built on `<Menu>` for its disclosure mechanics only - open state, outside-click and Escape
 * dismissal, viewport-clamped placement, the phone bottom sheet - carried entirely by one
 * `content` entry. The panel stays a `region` of real links rather than becoming a `role="menu"`
 * of `menuitem`s: every workspace row is *two* destinations (open it, or manage it), and several
 * other test suites (`workspace-routing`, `workspace-binding`, `workspace-management`) already
 * query this panel as `getByRole('region', { name: 'Workspaces' })` with plain links inside it.
 * Changing that shape here would be correct in isolation and a regression everywhere else that
 * already agreed on it.
 */
export function WorkspaceSwitcher(): ReactNode {
  const { workspace, items, dialogs } = useWorkspacePanel();
  return (
    <>
      <Menu label="Workspaces" items={items} className="w-80 max-w-[calc(100vw-1rem)]">
        {(trigger) => (
          <button
            {...trigger}
            // Starts with the visible name so voice control can say what it sees (WCAG 2.5.3).
            aria-label={`${workspace.name}, workspace menu`}
            className={`flex min-w-0 items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-xs text-muted hover:bg-foreground/7 hover:text-foreground pointer-coarse:min-h-11 ${focusRing}`}
          >
            <span className="truncate">{workspace.name}</span>
            <WorkspaceLockMark workspace={workspace} />
            <Icon icon={ChevronDown} size="sm" />
          </button>
        )}
      </Menu>
      {dialogs}
    </>
  );
}

const RECENT_LIMIT = 8;
const NEW_GROUP = '__new__';

/**
 * The workspace entries for the profile menu: the most recently used workspaces with a tick on the
 * current one, "All workspaces…" (the full switcher panel in a dialog) once there are more than
 * the limit, and "New workspace" through the same create flow the switcher uses.
 */
export function useWorkspaceMenuEntries(): { entries: MenuEntry[]; dialogs: ReactNode } {
  const { workspace, workspaces } = useWorkspace();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const closeDialog = (): void => {
    setCreating(false);
  };
  const dialogs = creating ? (
    <Dialog open title="New workspace" onClose={closeDialog}>
      <CreateWorkspaceForm onCreated={closeDialog} />
    </Dialog>
  ) : null;
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const recent = readRecentWorkspaceIds();
  const rank = (id: string): number => {
    const at = recent.indexOf(id);
    return at === -1 ? recent.length : at;
  };
  // Array.sort is stable, so workspaces never opened here keep the server's order.
  const shown = [...active].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, RECENT_LIMIT);
  const entries: MenuEntry[] = [
    ...shown.map((entry): MenuEntry => ({
      kind: 'action',
      key: `workspace-${entry.id}`,
      label: entry.name,
      role: 'menuitemradio',
      checked: entry.id === workspace.id,
      onSelect: () => void navigate(`/w/${entry.id}`),
    })),
    // Always offered, not only past the limit: the page is also where pinning, groups,
    // archived workspaces and per-workspace management live.
    {
      kind: 'action',
      label: 'All workspaces…',
      icon: Layers,
      onSelect: () => void navigate(`/w/${workspace.id}/workspaces`),
    },
    {
      kind: 'action',
      label: 'New workspace',
      icon: Plus,
      onSelect: () => {
        setCreating(true);
      },
    },
  ];
  return { entries, dialogs };
}

/** The switcher panel as a page: every workspace with search, pins, groups, Manage and New workspace. */
export function WorkspacesPanel(): ReactNode {
  const searchRef = useRef<HTMLInputElement>(null);
  const { items, dialogs } = useWorkspacePanel(searchRef, true);
  // Arriving here means "find a workspace", so the search takes focus as it did in the dialog.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  const content = items[0];
  return (
    <>
      {content?.kind === 'content' && typeof content.content === 'function'
        ? content.content({ close: () => undefined })
        : null}
      {dialogs}
    </>
  );
}

function useWorkspacePanel(
  searchRef?: RefObject<HTMLInputElement | null>,
  page = false,
): {
  readonly workspace: Workspace;
  readonly items: MenuEntry[];
  readonly dialogs: ReactNode;
} {
  const { workspace, workspaces, listStatus, listWarning, reload } = useWorkspace();
  const activeWorkspaces = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const archivedCount = workspaces.filter((entry) => entry.lifecycleState === 'archived').length;
  // The person's own groups and pins (requirements 4 and 5), laid over what they can see now.
  const { arrangement, save } = useWorkspaceArrangement();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const arranged = arrangeWorkspaces(activeWorkspaces, arrangement);
  const pinnedIds = new Set(arrangement.pinnedWorkspaceIds);
  // Creating and arranging workspaces open over the page; they live outside the menu panel, which
  // unmounts when it closes.
  const [dialog, setDialog] = useState<'create' | 'arrange' | null>(null);
  // On the page the list takes the room it has; in the menu it scrolls inside a fixed height.
  const listClass = page ? 'py-1' : 'max-h-72 overflow-y-auto py-1';
  const menuAction =
    (kind: 'create' | 'arrange', close: () => void): (() => void) =>
    () => {
      close();
      setDialog(kind);
    };

  const latest = useRef({ arrangement, save });
  useEffect(() => {
    latest.current = { arrangement, save };
  });
  const undo = useUndo();
  const [newGroupFor, setNewGroupFor] = useState<string | null>(null);
  const groupOf = (id: string): { readonly id: string; readonly name: string } | undefined =>
    arrangement.groups.find((group) => group.workspaceIds.includes(id));

  // Saves, then records the inverse. Undo re-reads the latest saved arrangement, so it reverses only
  // this action and keeps anything done since.
  const apply = async (
    next: WorkspaceArrangementInput,
    label: string,
    reverse: (current: WorkspaceArrangementInput) => WorkspaceArrangementInput,
  ): Promise<void> => {
    if (!(await save(next))) return;
    undo.push(label, async () => {
      await latest.current.save(reverse(latest.current.arrangement));
    });
  };
  const pin = (entry: Workspace): void => {
    const was = pinnedIds.has(entry.id);
    void apply(
      togglePin(arrangement, entry.id),
      `${was ? 'Unpinned' : 'Pinned'} ${entry.name}`,
      (current) =>
        current.pinnedWorkspaceIds.includes(entry.id) === was
          ? current
          : togglePin(current, entry.id),
    );
  };
  // shortcut: undo puts the workspace back at the end of its old group, not at its old position.
  const file = (entry: Workspace, groupId: string | null): void => {
    const before = groupOf(entry.id);
    const target = arrangement.groups.find((group) => group.id === groupId);
    if (before?.id === target?.id) return;
    void apply(
      assignToGroup(arrangement, entry.id, groupId),
      target === undefined
        ? `Removed ${entry.name} from ${before?.name ?? 'its group'}`
        : `Filed ${entry.name} in ${target.name}`,
      (current) => assignToGroup(current, entry.id, before?.id ?? null),
    );
  };
  const createGroupFor = (entry: Workspace, name: string): void => {
    const before = groupOf(entry.id);
    const added = addGroup(arrangement, name);
    const created = added.groups[added.groups.length - 1];
    if (created === undefined) return;
    setNewGroupFor(null);
    void apply(
      assignToGroup(added, entry.id, created.id),
      `Created group ${created.name} with ${entry.name}`,
      (current) => removeGroup(assignToGroup(current, entry.id, before?.id ?? null), created.id),
    );
  };

  const row = (entry: Workspace, close: () => void, hit?: 'first' | 'match'): ReactNode => (
    <WorkspaceRow
      key={entry.id}
      entry={entry}
      current={entry.id === workspace.id}
      pinned={pinnedIds.has(entry.id)}
      group={page ? (groupOf(entry.id) ?? null) : undefined}
      groups={arrangement.groups}
      hit={hit}
      creating={newGroupFor === entry.id}
      close={close}
      onPin={pin}
      onFile={file}
      onStartCreate={setNewGroupFor}
      onCreate={createGroupFor}
    />
  );

  const items: MenuEntry[] = [
    {
      kind: 'content',
      content: ({ close }) => (
        <section aria-label="Workspaces">
          {page ? null : (
            <div className="border-b border-divider px-3 py-2">
              <Text variant="bodySmall">Workspaces</Text>
            </div>
          )}

          <WorkspaceSearch
            workspaces={activeWorkspaces}
            row={row}
            close={close}
            inputRef={searchRef}
            listClass={listClass}
          >
            <div className={page ? `${listClass} md:columns-2 md:gap-3` : listClass}>
              {arranged.pinned.length > 0 ? (
                <section className="break-inside-avoid">
                  <Text
                    as="h3"
                    variant="kicker"
                    tone="muted"
                    className="px-3 pt-1"
                    id="workspaces-pinned"
                  >
                    Pinned
                  </Text>
                  <ul aria-labelledby="workspaces-pinned">
                    {arranged.pinned.map((entry) => row(entry, close))}
                  </ul>
                </section>
              ) : null}
              {arranged.groups.map((group) => (
                <section
                  key={group.id}
                  className="break-inside-avoid"
                  aria-labelledby={`workspaces-group-${group.id}`}
                >
                  <div className="flex items-center gap-1 px-1">
                    <button
                      type="button"
                      id={`workspaces-group-${group.id}`}
                      aria-expanded={!collapsedGroups.has(group.id)}
                      aria-controls={`workspaces-group-content-${group.id}`}
                      onClick={() => {
                        setCollapsedGroups((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        });
                      }}
                      className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-muted hover:bg-foreground/7 ${focusRing}`}
                    >
                      <Icon
                        icon={ChevronDown}
                        size="sm"
                        className={collapsedGroups.has(group.id) ? '-rotate-90' : ''}
                      />
                      <span className="truncate">{group.name}</span>
                      <span aria-hidden="true" className="ml-auto shrink-0">
                        {group.workspaces.length}
                      </span>
                    </button>
                    <Link
                      to={`/workspaces/groups/${group.id}`}
                      aria-label={`Manage group ${group.name}`}
                      onClick={close}
                      className={`flex size-(--control-sm) shrink-0 items-center justify-center text-muted hover:bg-foreground/7 pointer-coarse:size-(--control-lg) ${focusRing}`}
                    >
                      <Icon icon={Settings} size="sm" />
                    </Link>
                  </div>
                  <div
                    id={`workspaces-group-content-${group.id}`}
                    hidden={collapsedGroups.has(group.id)}
                  >
                    {group.workspaces.length === 0 ? (
                      <Text as="p" variant="caption" tone="muted" className="px-3 py-2">
                        No workspaces in this group yet.
                      </Text>
                    ) : (
                      <ul aria-labelledby={`workspaces-group-${group.id}`}>
                        {group.workspaces.map((entry) => row(entry, close))}
                      </ul>
                    )}
                  </div>
                </section>
              ))}
              <section className="break-inside-avoid">
                {arranged.groups.length > 0 && arranged.ungrouped.length > 0 ? (
                  <Text
                    as="h3"
                    variant="kicker"
                    tone="muted"
                    className="px-3 pt-1"
                    id="workspaces-ungrouped"
                  >
                    Other workspaces
                  </Text>
                ) : null}
                <ul
                  aria-label={arranged.groups.length > 0 ? undefined : 'Your workspaces'}
                  aria-labelledby={arranged.groups.length > 0 ? 'workspaces-ungrouped' : undefined}
                >
                  {arranged.ungrouped.map((entry) => row(entry, close))}
                </ul>
              </section>
            </div>
          </WorkspaceSearch>

          {listStatus === 'partial' ? (
            <div className="border-t border-divider px-3 py-2">
              <Text variant="caption" as="p" tone="muted" role="status">
                {listWarning ?? 'Some workspaces could not be loaded.'}
              </Text>
              <button
                type="button"
                onClick={reload}
                className={`mt-1 text-xs text-accent-text underline pointer-coarse:min-h-11 ${focusRing}`}
              >
                Try again
              </button>
            </div>
          ) : null}

          <Link
            to="/workspaces/groups"
            onClick={close}
            className={`flex items-center border-t border-divider px-3 py-2 text-sm text-foreground hover:bg-accent/10 pointer-coarse:min-h-11 ${focusRing}`}
          >
            Workspace groups
          </Link>

          {archivedCount > 0 ? (
            <Link
              to="/workspaces/archived"
              onClick={close}
              className="flex items-center gap-2 border-t border-divider px-3 py-2 text-sm text-foreground no-underline pointer-coarse:min-h-11 hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              <Icon icon={Archive} size="sm" />
              Archived workspaces ({archivedCount})
            </Link>
          ) : null}

          <button
            type="button"
            onClick={menuAction('arrange', close)}
            className={`flex w-full items-center border-t border-divider px-3 py-2 text-left pointer-coarse:min-h-11 text-sm text-foreground hover:bg-accent/10 ${focusRing}`}
          >
            Arrange workspaces…
          </button>

          <button
            type="button"
            onClick={menuAction('create', close)}
            className={`flex w-full items-center gap-2 border-t border-divider px-3 py-2 text-left pointer-coarse:min-h-11 text-sm text-foreground hover:bg-accent/10 ${focusRing}`}
          >
            <Icon icon={Plus} size="sm" />
            New workspace…
          </button>
        </section>
      ),
    },
  ];

  const closeDialog = (): void => {
    setDialog(null);
  };

  const dialogs = (
    <>
      {dialog === 'create' ? (
        <Dialog open title="New workspace" onClose={closeDialog}>
          <CreateWorkspaceForm onCreated={closeDialog} />
        </Dialog>
      ) : null}
      {dialog === 'arrange' ? (
        <Dialog open title="Arrange workspaces" onClose={closeDialog}>
          <WorkspaceGroupsSection />
        </Dialog>
      ) : null}
    </>
  );

  return { workspace, items, dialogs };
}

/**
 * A search box over the switcher's list. While it holds text, pins and groups give way to one flat
 * list of the matching workspaces, and Enter opens the first. It lives inside the menu panel, which
 * unmounts on close, so every opening starts with an empty search.
 */
function WorkspaceSearch({
  workspaces,
  row,
  close,
  inputRef,
  listClass,
  children,
}: {
  readonly listClass: string;
  readonly inputRef: RefObject<HTMLInputElement | null> | undefined;
  readonly workspaces: readonly Workspace[];
  readonly row: (entry: Workspace, close: () => void, hit?: 'first' | 'match') => ReactNode;
  readonly close: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const needle = query.trim().toLocaleLowerCase();
  const matches =
    needle === ''
      ? []
      : workspaces.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));

  return (
    <>
      <div className="px-2 pt-2">
        <Input
          type="search"
          aria-label="Search workspaces"
          placeholder="Search workspaces"
          // Takes focus when the workspaces screen opens as a dialog (see `<Dialog>`).
          data-autofocus
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            const first = matches[0];
            if (event.key === 'Enter' && first !== undefined) {
              event.preventDefault();
              close();
              void navigate(`/w/${first.id}`);
            }
          }}
        />
      </div>
      {needle === '' ? (
        children
      ) : (
        <div className={listClass}>
          {matches.length === 0 ? (
            <Text as="p" variant="caption" tone="muted" role="status" className="px-3 py-2">
              No workspace matches “{query.trim()}”.
            </Text>
          ) : (
            <ul aria-label="Matching workspaces">
              {matches.map((entry, index) => row(entry, close, index === 0 ? 'first' : 'match'))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/**
 * One workspace in the list: open, pin, file into a group (a folder button over a native select, so
 * it is a real picker on a phone), and manage. Pinning and filing flash the row and are undoable.
 */
function WorkspaceRow({
  entry,
  current,
  pinned,
  group,
  groups,
  hit,
  creating,
  close,
  onPin,
  onFile,
  onStartCreate,
  onCreate,
}: {
  readonly entry: Workspace;
  readonly current: boolean;
  readonly pinned: boolean;
  /** The group it sits in; `undefined` hides the group controls (the menu variant). */
  readonly group: { readonly id: string; readonly name: string } | null | undefined;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly hit: 'first' | 'match' | undefined;
  readonly creating: boolean;
  readonly close: () => void;
  readonly onPin: (entry: Workspace) => void;
  readonly onFile: (entry: Workspace, groupId: string | null) => void;
  readonly onStartCreate: (workspaceId: string | null) => void;
  readonly onCreate: (entry: Workspace, name: string) => void;
}): ReactNode {
  const flash = useFlash(`${String(pinned)}|${group?.id ?? ''}`);
  const [name, setName] = useState('');
  const iconButton =
    'flex size-(--control-sm) shrink-0 items-center justify-center rounded-md text-muted transition-transform hover:bg-accent/10 hover:text-foreground active:scale-90 pointer-coarse:size-(--control-lg)';
  return (
    <li
      {...flash}
      className="flex flex-wrap items-center gap-1 px-1 pointer-coarse:min-h-(--control-lg)"
    >
      <Link
        to={`/w/${entry.id}`}
        aria-current={current ? 'page' : undefined}
        onClick={close}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-3 text-md text-foreground no-underline hover:bg-accent/10 active:bg-foreground/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Icon icon={Check} size="sm" className={current ? 'text-accent-text' : 'invisible'} />
        <span className="truncate">{entry.name}</span>
        <WorkspaceLockMark workspace={entry} />
        {entry.pendingInvitationId === null ? null : (
          <Text variant="caption" as="span" tone="muted" className="shrink-0">
            Invited
          </Text>
        )}
        {/* Visual hints only: the link's name stays the workspace's name. */}
        {hit !== undefined && group ? (
          <span aria-hidden="true" className="shrink-0">
            <Text variant="caption" as="span" tone="muted">
              {group.name}
            </Text>
          </span>
        ) : null}
        {hit === 'first' ? (
          <span
            aria-hidden="true"
            title="Enter opens this one"
            className="hidden shrink-0 pointer-fine:inline"
          >
            <Text variant="caption" as="span" tone="muted">
              ↵
            </Text>
          </span>
        ) : null}
      </Link>
      <button
        type="button"
        aria-label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
        aria-pressed={pinned}
        onClick={() => {
          onPin(entry);
        }}
        className={`${iconButton} ${focusRing}`}
      >
        <Icon icon={pinned ? PinOff : Pin} size="sm" />
      </button>
      {group === undefined ? null : (
        <div
          title={group === null ? 'Add to a group' : `In ${group.name} - change group`}
          className={`relative ${iconButton} focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${group === null ? '' : 'text-accent-text'}`}
        >
          <Icon icon={FolderClosed} size="sm" />
          <Select
            aria-label={`Group for ${entry.name}`}
            value={group?.id ?? ''}
            className="absolute inset-0 h-full min-h-0 w-full cursor-pointer border-0 p-0 opacity-0 any-pointer-coarse:h-full"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value === NEW_GROUP) {
                setName('');
                onStartCreate(entry.id);
              } else onFile(entry, value === '' ? null : value);
            }}
          >
            <option value="">No group</option>
            {groups.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            <option value={NEW_GROUP}>New group…</option>
          </Select>
        </div>
      )}
      <Link
        to={`/w/${entry.id}/settings`}
        aria-label={`Manage ${entry.name}`}
        onClick={close}
        className={`${iconButton} no-underline ${focusRing}`}
      >
        <Icon icon={Settings} size="sm" />
      </Link>
      {creating ? (
        <form
          className="flex w-full items-center gap-1 pb-2 pl-8"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) onCreate(entry, name);
          }}
        >
          <Input
            aria-label={`New group for ${entry.name}`}
            placeholder="New group name"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Justification: the person just chose "New group…" from this row's picker.
            autoFocus
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onStartCreate(null);
            }}
          />
          <Button type="submit" disabled={name.trim().length === 0}>
            Add
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onStartCreate(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </li>
  );
}
