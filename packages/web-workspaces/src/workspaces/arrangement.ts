import type { Workspace, WorkspaceArrangementInput, WorkspaceGroup } from '@nix/api-client';

/**
 * One person's workspace groups and pins laid over the workspaces they can currently see.
 *
 * The stored document may name workspaces the person has since lost or archived; they are filtered
 * here rather than rewritten, so losing access never changes the document. Pure, so the switcher
 * and the management section agree on what is grouped, pinned and left over.
 */
export interface ArrangedGroup {
  readonly id: string;
  readonly name: string;
  readonly workspaces: readonly Workspace[];
}

export interface ArrangedWorkspaces {
  readonly pinned: readonly Workspace[];
  readonly groups: readonly ArrangedGroup[];
  readonly ungrouped: readonly Workspace[];
}

export const EMPTY_ARRANGEMENT: WorkspaceArrangementInput = { groups: [], pinnedWorkspaceIds: [] };

export function arrangeWorkspaces(
  workspaces: readonly Workspace[],
  arrangement: WorkspaceArrangementInput,
): ArrangedWorkspaces {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const grouped = new Set<string>();
  const groups = arrangement.groups.map((group) => ({
    id: group.id,
    name: group.name,
    workspaces: group.workspaceIds.flatMap((id) => {
      const workspace = byId.get(id);
      if (workspace === undefined) return [];
      grouped.add(id);
      return [workspace];
    }),
  }));
  return {
    pinned: arrangement.pinnedWorkspaceIds.flatMap((id) => {
      const workspace = byId.get(id);
      return workspace === undefined ? [] : [workspace];
    }),
    groups,
    ungrouped: workspaces.filter((workspace) => !grouped.has(workspace.id)),
  };
}

export function togglePin(
  arrangement: WorkspaceArrangementInput,
  workspaceId: string,
): WorkspaceArrangementInput {
  const pinned = arrangement.pinnedWorkspaceIds.includes(workspaceId)
    ? arrangement.pinnedWorkspaceIds.filter((id) => id !== workspaceId)
    : [...arrangement.pinnedWorkspaceIds, workspaceId];
  return { ...arrangement, pinnedWorkspaceIds: pinned };
}

/** Puts a workspace in one group (or none), removing it from any other: a workspace sits in one place. */
export function assignToGroup(
  arrangement: WorkspaceArrangementInput,
  workspaceId: string,
  groupId: string | null,
): WorkspaceArrangementInput {
  return {
    ...arrangement,
    groups: arrangement.groups.map((group) => {
      const without = group.workspaceIds.filter((id) => id !== workspaceId);
      return group.id === groupId
        ? { ...group, workspaceIds: [...without, workspaceId] }
        : { ...group, workspaceIds: without };
    }),
  };
}

export function addGroup(
  arrangement: WorkspaceArrangementInput,
  name: string,
): WorkspaceArrangementInput {
  const group: WorkspaceGroup = { id: crypto.randomUUID(), name: name.trim(), workspaceIds: [] };
  return { ...arrangement, groups: [...arrangement.groups, group] };
}

export function renameGroup(
  arrangement: WorkspaceArrangementInput,
  groupId: string,
  name: string,
): WorkspaceArrangementInput {
  return {
    ...arrangement,
    groups: arrangement.groups.map((group) =>
      group.id === groupId ? { ...group, name: name.trim() } : group,
    ),
  };
}

/** Removing a group only ungroups its workspaces; nothing about them changes. */
export function removeGroup(
  arrangement: WorkspaceArrangementInput,
  groupId: string,
): WorkspaceArrangementInput {
  return { ...arrangement, groups: arrangement.groups.filter((group) => group.id !== groupId) };
}

export function moveGroup(
  arrangement: WorkspaceArrangementInput,
  groupId: string,
  by: -1 | 1,
): WorkspaceArrangementInput {
  const index = arrangement.groups.findIndex((group) => group.id === groupId);
  const target = index + by;
  if (index === -1 || target < 0 || target >= arrangement.groups.length) return arrangement;
  const groups = [...arrangement.groups];
  const [moved] = groups.splice(index, 1);
  if (moved === undefined) return arrangement;
  groups.splice(target, 0, moved);
  return { ...arrangement, groups };
}
