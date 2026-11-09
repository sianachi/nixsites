import type { Workspace, WorkspaceArrangementInput } from '@nix/api-client';
import { Button, Input, Text, useUndo } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  addGroup,
  arrangeWorkspaces,
  assignToGroup,
  moveGroup,
  removeGroup,
  renameGroup,
  togglePin,
} from './arrangement';
import { GroupCard, MemberRow } from './workspace-group-card';
import { useWorkspaceArrangement } from './use-workspace-arrangement';
import { useAccessibleWorkspaces } from './workspace-context';

/**
 * The person's own workspace groups and pins (requirements 4 and 5) as a board: a card per group
 * listing its workspaces, plus a "No group" card. Tick workspaces (or drag one) to file or pin
 * several at once; rename, order and remove groups on their card. Every change says what it did and
 * can be undone. Nothing here changes a workspace, its members or who may open it; removing a group
 * only ungroups what was in it.
 */
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
  const undo = useUndo();
  const latest = useRef({ arrangement, save });
  useEffect(() => {
    latest.current = { arrangement, save };
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [entered, setEntered] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [dragging, setDragging] = useState<readonly string[] | null>(null);

  const selectedGroup = arrangement.groups.find((group) => group.id === groupId);
  const arranged = arrangeWorkspaces(active, arrangement);
  const pinnedIds = new Set(arrangement.pinnedWorkspaceIds);
  const ids = selected.size > 0 ? active.filter((entry) => selected.has(entry.id)) : [];
  const groupOf = (id: string): string | null =>
    arrangement.groups.find((group) => group.workspaceIds.includes(id))?.id ?? null;
  const what = (list: readonly Workspace[]): string =>
    list.length === 1 ? (list[0]?.name ?? '') : `${String(list.length)} workspaces`;

  // Saves, then records the inverse. Undo re-reads the latest saved arrangement, so it reverses
  // only this action and keeps anything done since.
  const apply = async (
    next: WorkspaceArrangementInput,
    label: string,
    reverse: (current: WorkspaceArrangementInput) => WorkspaceArrangementInput,
  ): Promise<boolean> => {
    if (!(await save(next))) return false;
    undo.push(label, async () => {
      await latest.current.save(reverse(latest.current.arrangement));
    });
    return true;
  };

  // shortcut: undo puts a workspace back at the end of its old group, not at its old position.
  const file = (list: readonly Workspace[], target: string | null, makeGroup = false): void => {
    const moving = list.filter((entry) => groupOf(entry.id) !== target || makeGroup);
    if (moving.length === 0) return;
    const before = new Map(moving.map((entry) => [entry.id, groupOf(entry.id)]));
    let base = arrangement;
    let into = target;
    if (makeGroup) {
      base = addGroup(arrangement, 'New group');
      into = base.groups[base.groups.length - 1]?.id ?? null;
    }
    const name = base.groups.find((group) => group.id === into)?.name;
    const next = moving.reduce((acc, entry) => assignToGroup(acc, entry.id, into), base);
    const from = before.get(moving[0]?.id ?? '');
    const oldName = arrangement.groups.find((group) => group.id === from)?.name;
    const label =
      name === undefined
        ? `Removed ${what(moving)} from ${moving.length === 1 ? (oldName ?? 'its group') : 'their groups'}`
        : makeGroup
          ? `Created group ${name} with ${what(moving)}`
          : `Filed ${what(moving)} in ${name}`;
    setSelected(new Set());
    void apply(next, label, (current) => {
      const restored = [...before].reduce(
        (acc, [id, group]) =>
          assignToGroup(acc, id, acc.groups.some((g) => g.id === group) ? group : null),
        current,
      );
      return makeGroup && into !== null ? removeGroup(restored, into) : restored;
    }).then((ok) => {
      if (ok && makeGroup) {
        setEntered(into);
        setRenaming(into);
      }
    });
  };

  const pin = (list: readonly Workspace[], on: boolean): void => {
    const changing = list.filter((entry) => pinnedIds.has(entry.id) !== on);
    if (changing.length === 0) return;
    const next = changing.reduce((acc, entry) => togglePin(acc, entry.id), arrangement);
    setSelected(new Set());
    void apply(next, `${on ? 'Pinned' : 'Unpinned'} ${what(changing)}`, (current) =>
      changing.reduce(
        (acc, entry) =>
          acc.pinnedWorkspaceIds.includes(entry.id) === on ? togglePin(acc, entry.id) : acc,
        current,
      ),
    );
  };

  const create = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    const added = addGroup(arrangement, name);
    const created = added.groups[added.groups.length - 1];
    if (created === undefined) return;
    void apply(added, `Created group ${name}`, (current) => removeGroup(current, created.id)).then(
      (ok) => {
        if (!ok) return;
        setNewName('');
        setEntered(created.id);
      },
    );
  };

  const rename = (id: string, name: string): void => {
    const old = arrangement.groups.find((group) => group.id === id)?.name ?? '';
    setRenaming(null);
    void apply(renameGroup(arrangement, id, name), `Renamed ${old} to ${name}`, (current) =>
      renameGroup(current, id, old),
    );
  };

  const reorder = (id: string, by: -1 | 1): void => {
    const name = arrangement.groups.find((group) => group.id === id)?.name ?? '';
    void apply(
      moveGroup(arrangement, id, by),
      `Moved group ${name} ${by < 0 ? 'up' : 'down'}`,
      (current) => moveGroup(current, id, by < 0 ? 1 : -1),
    );
  };

  const remove = (id: string): void => {
    const index = arrangement.groups.findIndex((group) => group.id === id);
    const group = arrangement.groups[index];
    if (group === undefined) return;
    void apply(removeGroup(arrangement, id), `Removed group ${group.name}`, (current) => {
      if (current.groups.some((entry) => entry.id === id)) return current;
      const taken = new Set(current.groups.flatMap((entry) => entry.workspaceIds));
      const groups = [...current.groups];
      groups.splice(Math.min(index, groups.length), 0, {
        ...group,
        workspaceIds: group.workspaceIds.filter((workspaceId) => !taken.has(workspaceId)),
      });
      return { ...current, groups };
    });
  };

  const select = (id: string, on: boolean): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  if (groupId !== undefined && !loading && error === null && selectedGroup === undefined) {
    return <Text role="status">This workspace group no longer exists.</Text>;
  }

  const allPinned = ids.length > 0 && ids.every((entry) => pinnedIds.has(entry.id));
  const dropOn = (target: string | null): void => {
    const list = active.filter((entry) => dragging?.includes(entry.id));
    setDragging(null);
    file(list, target);
  };
  const members = (entries: readonly Workspace[], placeKey: string): ReactNode =>
    entries.map((entry) => (
      <MemberRow
        key={entry.id}
        entry={entry}
        pinned={pinnedIds.has(entry.id)}
        placeKey={placeKey}
        selected={selected.has(entry.id)}
        disabled={saving}
        onSelect={select}
        onPin={(one) => {
          pin([one], !pinnedIds.has(one.id));
        }}
        onDragStart={(id) => {
          setDragging(selected.has(id) ? [...selected] : [id]);
        }}
        onDragEnd={() => {
          setDragging(null);
        }}
      />
    ));

  return (
    <section
      aria-labelledby="workspace-groups-heading"
      aria-busy={saving}
      className="flex flex-col gap-3"
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
          {pinnedIds.size > 0
            ? `Pinned: ${active
                .filter((entry) => pinnedIds.has(entry.id))
                .map((entry) => entry.name)
                .join(', ')}. `
            : 'Nothing pinned yet. '}
          Pin and group workspaces in your own menu. Groups are personal and do not grant access.
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
          {groupId === undefined ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <Input
                aria-label="New group name"
                value={newName}
                maxLength={80}
                onChange={(event) => {
                  setNewName(event.currentTarget.value);
                }}
              />
              <Button type="submit" disabled={saving || newName.trim().length === 0}>
                Create group
              </Button>
            </form>
          ) : null}
          <div
            role="group"
            aria-label="Selected workspaces"
            className={`sticky top-0 z-10 flex min-h-13 flex-col justify-center gap-1 rounded-lg border px-3 py-2 ${ids.length > 0 ? 'border-accent bg-accent/10' : 'border-divider bg-background'}`}
          >
            {ids.length === 0 ? (
              <Text variant="note" tone="muted">
                Tick workspaces (or drag them) to move or pin several at once.
              </Text>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Text as="span" variant="bodySmall">
                    {ids.length} selected
                  </Text>
                  <Button
                    variant="secondary"
                    disabled={saving}
                    onClick={() => {
                      pin(ids, !allPinned);
                    }}
                  >
                    {allPinned ? 'Unpin' : 'Pin'}
                  </Button>
                  <Button
                    variant="subtle"
                    onClick={() => {
                      setSelected(new Set());
                    }}
                  >
                    Clear
                  </Button>
                </div>
                <div
                  className="flex items-center gap-2 overflow-x-auto"
                  role="group"
                  aria-label="Move selected to"
                >
                  <Text as="span" variant="note" tone="muted">
                    Move to
                  </Text>
                  {arrangement.groups.map((group) => (
                    <Button
                      key={group.id}
                      variant="secondary"
                      className="shrink-0 rounded-full"
                      disabled={saving}
                      onClick={() => {
                        file(ids, group.id);
                      }}
                    >
                      {group.name}
                    </Button>
                  ))}
                  <Button
                    variant="secondary"
                    className="shrink-0 rounded-full"
                    disabled={saving}
                    onClick={() => {
                      file(ids, null);
                    }}
                  >
                    No group
                  </Button>
                  <Button
                    variant="secondary"
                    className="shrink-0 rounded-full"
                    disabled={saving}
                    onClick={() => {
                      file(ids, null, true);
                    }}
                  >
                    + New group
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {arranged.groups.map((group, index) => (
              <GroupCard
                key={group.id}
                group={group}
                members={group.workspaces.length}
                manage={groupId === undefined || group.id === groupId}
                link={groupId === undefined}
                first={index === 0}
                last={index === arranged.groups.length - 1}
                entering={entered === group.id}
                editing={renaming === group.id}
                disabled={saving}
                dropActive={dragging !== null}
                onEdit={setRenaming}
                onRename={rename}
                onMove={reorder}
                onRemove={remove}
                onDropHere={dropOn}
              >
                {members(group.workspaces, group.id)}
              </GroupCard>
            ))}
            <GroupCard
              group={null}
              members={arranged.ungrouped.length}
              manage={false}
              link={false}
              first
              last
              entering={false}
              editing={false}
              disabled={saving}
              dropActive={dragging !== null}
              onEdit={setRenaming}
              onRename={rename}
              onMove={reorder}
              onRemove={remove}
              onDropHere={dropOn}
            >
              {members(arranged.ungrouped, '')}
            </GroupCard>
          </div>
        </>
      )}
    </section>
  );
}
