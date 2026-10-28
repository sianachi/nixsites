import { Button, Icon, Input, Select, Text } from '@nix/ui';
import { ArrowDown, ArrowUp, Pin, PinOff, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  addGroup,
  assignToGroup,
  moveGroup,
  removeGroup,
  renameGroup,
  togglePin,
} from './arrangement';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { useAccessibleWorkspaces } from './workspace-context';

/**
 * The person's own workspace groups and pins (requirements 4 and 5): one row per workspace with a
 * pin toggle and a group select (whose last option makes a new group), and a collapsed "Manage
 * groups" list for rename, order and remove. Nothing here changes a workspace, its members or who
 * may open it; removing a group only ungroups what was in it.
 */
const NEW_GROUP = '__new__';

export function WorkspaceGroupsSection({
  groupId,
  headingLevel,
}: {
  readonly groupId?: string;
  readonly headingLevel?: 'h2' | 'h3';
}): ReactNode {
  const { workspaces } = useAccessibleWorkspaces();
  const active = workspaces.filter((entry) => entry.lifecycleState === 'active');
  const { arrangement, loading, saving, error, save } = useWorkspaceArrangement();
  const selectedGroup = arrangement.groups.find((group) => group.id === groupId);
  const managedGroups =
    groupId === undefined
      ? arrangement.groups
      : arrangement.groups.filter((group) => group.id === groupId);
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const groupOf = (workspaceId: string): string =>
    arrangement.groups.find((group) => group.workspaceIds.includes(workspaceId))?.id ?? '';

  const createAndAssign = (workspaceId: string): void => {
    const name = newGroupName.trim();
    if (name.length === 0) return;
    const added = addGroup(arrangement, name);
    const created = added.groups[added.groups.length - 1];
    if (created === undefined) return;
    void save(assignToGroup(added, workspaceId, created.id)).then((ok) => {
      if (ok) {
        setCreatingFor(null);
        setNewGroupName('');
      }
    });
  };

  if (groupId !== undefined && !loading && error === null && selectedGroup === undefined) {
    return <Text role="status">This workspace group no longer exists.</Text>;
  }

  return (
    <section
      aria-labelledby="workspace-groups-heading"
      aria-busy={saving}
      className="flex flex-col gap-2"
    >
      <div className="flex flex-col gap-1">
        <Text
          id="workspace-groups-heading"
          variant="h3"
          as={headingLevel ?? (groupId === undefined ? 'h3' : 'h2')}
        >
          {selectedGroup?.name ?? 'Workspace groups and pins'}
        </Text>
        <Text variant="note" tone="muted">
          Pin and group workspaces in your own menu.
        </Text>
      </div>
      {error === null ? null : (
        <Text role="alert" variant="note">
          {error}
        </Text>
      )}
      {loading ? (
        <Text variant="note" tone="muted" role="status">
          Loading your groups…
        </Text>
      ) : (
        <>
          <ul aria-label="Arrange workspaces" className="flex flex-col divide-y divide-divider">
            {active.map((entry) => {
              const pinned = arrangement.pinnedWorkspaceIds.includes(entry.id);
              return (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 py-1.5">
                  <Text as="span" variant="bodySmall" className="min-w-0 flex-1 truncate">
                    {entry.name}
                  </Text>
                  <Button
                    variant="icon"
                    aria-label={`${pinned ? 'Unpin' : 'Pin'} ${entry.name}`}
                    aria-pressed={pinned}
                    disabled={saving}
                    onClick={() => {
                      void save(togglePin(arrangement, entry.id));
                    }}
                  >
                    <Icon icon={pinned ? PinOff : Pin} size="sm" />
                  </Button>
                  {creatingFor === entry.id ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        createAndAssign(entry.id);
                      }}
                    >
                      <Input
                        aria-label={`New group for ${entry.name}`}
                        // eslint-disable-next-line jsx-a11y/no-autofocus -- Justification: the select that held focus is replaced by this input on the user's own choice.
                        autoFocus
                        value={newGroupName}
                        maxLength={80}
                        onChange={(event) => {
                          setNewGroupName(event.currentTarget.value);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setCreatingFor(null);
                        }}
                      />
                      <Button
                        type="submit"
                        variant="secondary"
                        disabled={saving || newGroupName.trim().length === 0}
                      >
                        Add
                      </Button>
                    </form>
                  ) : (
                    <Select
                      aria-label={`Group for ${entry.name}`}
                      className="min-w-40"
                      value={groupOf(entry.id)}
                      disabled={saving}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value === NEW_GROUP) {
                          setNewGroupName('');
                          setCreatingFor(entry.id);
                          return;
                        }
                        void save(
                          assignToGroup(arrangement, entry.id, value.length === 0 ? null : value),
                        );
                      }}
                    >
                      <option value="">No group</option>
                      {arrangement.groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                      <option value={NEW_GROUP}>New group…</option>
                    </Select>
                  )}
                </li>
              );
            })}
          </ul>

          {managedGroups.length === 0 ? null : (
            <details open={groupId !== undefined ? true : undefined} className="text-sm">
              <summary className="flex min-h-11 cursor-pointer items-center">Manage groups</summary>
              <Text variant="note" tone="muted">
                Only changes your menu. Removing a group keeps its workspaces.
              </Text>
              <ul aria-label="Workspace groups" className="flex flex-col gap-1 pt-1">
                {managedGroups.map((group) => (
                  <li key={group.id} className="flex items-center gap-1">
                    <Input
                      aria-label={`Name of group ${group.name}`}
                      className="min-w-0 flex-1"
                      key={group.name}
                      disabled={saving}
                      defaultValue={group.name}
                      maxLength={80}
                      onBlur={(event) => {
                        const name = event.currentTarget.value.trim();
                        if (name.length > 0 && name !== group.name) {
                          void save(renameGroup(arrangement, group.id, name));
                        }
                      }}
                    />
                    <Button
                      variant="icon"
                      aria-label={`Move ${group.name} up`}
                      disabled={saving || arrangement.groups[0]?.id === group.id}
                      onClick={() => {
                        void save(moveGroup(arrangement, group.id, -1));
                      }}
                    >
                      <Icon icon={ArrowUp} size="sm" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={`Move ${group.name} down`}
                      disabled={saving || arrangement.groups.at(-1)?.id === group.id}
                      onClick={() => {
                        void save(moveGroup(arrangement, group.id, 1));
                      }}
                    >
                      <Icon icon={ArrowDown} size="sm" />
                    </Button>
                    <Button
                      variant="icon"
                      aria-label={`Remove group ${group.name}`}
                      disabled={saving}
                      onClick={() => {
                        void save(removeGroup(arrangement, group.id));
                      }}
                    >
                      <Icon icon={Trash2} size="sm" />
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
