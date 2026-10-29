import { Dialog, Icon, Input, Menu, Text, focusRing, type MenuEntry } from '@nix/ui';
import { Archive, Check, ChevronDown, Pin, PinOff, Plus, Settings } from 'lucide-react';
import type { Workspace } from '@nix/api-client';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';

import { arrangeWorkspaces, togglePin } from './arrangement';
import { CreateWorkspaceForm } from './settings/create-workspace-form';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { useWorkspace } from './workspace-context';
import { WorkspaceGroupsSection } from './workspace-groups-section';

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
  const menuAction =
    (kind: 'create' | 'arrange', close: () => void): (() => void) =>
    () => {
      close();
      setDialog(kind);
    };

  const row = (entry: Workspace, close: () => void): ReactNode => (
    <li key={entry.id} className="flex items-center gap-1 px-1 pointer-coarse:min-h-(--control-lg)">
      <Link
        to={`/w/${entry.id}`}
        aria-current={entry.id === workspace.id ? 'page' : undefined}
        onClick={close}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-3 text-md text-foreground no-underline hover:bg-accent/10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Icon
          icon={Check}
          size="sm"
          className={entry.id === workspace.id ? 'text-accent-text' : 'invisible'}
        />
        <span className="truncate">{entry.name}</span>
        {entry.pendingInvitationId === null ? null : (
          <Text variant="caption" as="span" tone="muted" className="shrink-0">
            Invited
          </Text>
        )}
      </Link>
      <button
        type="button"
        aria-label={pinnedIds.has(entry.id) ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
        aria-pressed={pinnedIds.has(entry.id)}
        onClick={() => {
          void save(togglePin(arrangement, entry.id));
        }}
        className={`flex size-(--control-sm) shrink-0 items-center justify-center text-muted hover:bg-accent/10 hover:text-foreground pointer-coarse:size-(--control-lg) ${focusRing}`}
      >
        <Icon icon={pinnedIds.has(entry.id) ? PinOff : Pin} size="sm" />
      </button>
      <Link
        to={`/w/${entry.id}/settings`}
        aria-label={`Manage ${entry.name}`}
        onClick={close}
        className="flex size-(--control-sm) shrink-0 items-center justify-center text-muted no-underline hover:bg-accent/10 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent pointer-coarse:size-(--control-lg)"
      >
        <Icon icon={Settings} size="sm" />
      </Link>
    </li>
  );

  const items: MenuEntry[] = [
    {
      kind: 'content',
      content: ({ close }) => (
        <section aria-label="Workspaces">
          <div className="border-b border-divider px-3 py-2">
            <Text variant="bodySmall">Workspaces</Text>
          </div>

          <WorkspaceSearch workspaces={activeWorkspaces} row={row} close={close}>
            <div className="max-h-72 overflow-y-auto py-1">
              {arranged.pinned.length > 0 ? (
                <>
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
                </>
              ) : null}
              {arranged.groups.map((group) => (
                <section key={group.id} aria-labelledby={`workspaces-group-${group.id}`}>
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
            <Icon icon={ChevronDown} size="sm" />
          </button>
        )}
      </Menu>
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
  children,
}: {
  readonly workspaces: readonly Workspace[];
  readonly row: (entry: Workspace, close: () => void) => ReactNode;
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
        <div className="max-h-72 overflow-y-auto py-1">
          {matches.length === 0 ? (
            <Text as="p" variant="caption" tone="muted" role="status" className="px-3 py-2">
              No workspace matches “{query.trim()}”.
            </Text>
          ) : (
            <ul aria-label="Matching workspaces">{matches.map((entry) => row(entry, close))}</ul>
          )}
        </div>
      )}
    </>
  );
}
