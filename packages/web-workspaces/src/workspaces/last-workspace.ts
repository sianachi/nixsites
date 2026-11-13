import { useSyncExternalStore } from 'react';
import { useUndo } from '@nix/ui';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { writeStored } from '@nix/web-foundation/lib/stored-setting';
import { browserStorage } from '@nix/web-foundation/lib/browser-storage';

const LAST_WORKSPACE_KEY = 'nix.last-workspace-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readLastWorkspaceId(): string | null {
  try {
    const value = browserStorage()?.getItem(LAST_WORKSPACE_KEY) ?? null;
    return value !== null && UUID.test(value) ? value : null;
  } catch {
    return null;
  }
}

const RECENT_KEY = 'nix.recent-workspace-ids';
const HIDDEN_KEY = 'nix.hidden-workspace-previews';
const PREVIEWS_CHANGED = 'nix-workspace-previews-changed';

function readList(key: string): string {
  try {
    return browserStorage()?.getItem(key) ?? '[]';
  } catch {
    return '[]';
  }
}

function parseList(snapshot: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(snapshot);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isWorkspaceId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

interface WorkspaceVisit {
  readonly id: string;
  readonly count: number;
}

/** Older browsers stored only workspace ids, in visit order. Each starts with one visit. */
function workspaceVisits(snapshot: string): WorkspaceVisit[] {
  const visits = new Map<string, WorkspaceVisit>();
  for (const entry of parseList(snapshot)) {
    if (isWorkspaceId(entry)) {
      if (!visits.has(entry)) visits.set(entry, { id: entry, count: 1 });
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      isWorkspaceId(entry.id) &&
      'count' in entry &&
      typeof entry.count === 'number' &&
      Number.isSafeInteger(entry.count) &&
      entry.count > 0
    ) {
      visits.set(entry.id, { id: entry.id, count: entry.count });
    }
  }
  return [...visits.values()];
}

const readVisits = (): string => readList(RECENT_KEY);
const readHidden = (): string => readList(HIDDEN_KEY);

function subscribe(listener: () => void): () => void {
  function storageChanged(event: StorageEvent): void {
    if (event.key === null || event.key === RECENT_KEY || event.key === HIDDEN_KEY) listener();
  }
  window.addEventListener('storage', storageChanged);
  window.addEventListener(PREVIEWS_CHANGED, listener);
  return () => {
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener(PREVIEWS_CHANGED, listener);
  };
}

export function useMostUsedWorkspaceIds(): string[] {
  const visits = useSyncExternalStore(subscribe, readVisits);
  return workspaceVisits(visits)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.id);
}

export function useHiddenWorkspacePreviewIds(): ReadonlySet<string> {
  const hidden = useSyncExternalStore(subscribe, readHidden);
  return new Set(parseList(hidden).filter(isWorkspaceId));
}

function setWorkspacePreviewHidden(workspaceId: string, hidden: boolean): boolean {
  const ids = new Set(parseList(readHidden()).filter(isWorkspaceId));
  if (hidden) ids.add(workspaceId);
  else ids.delete(workspaceId);
  const saved = writeStored(HIDDEN_KEY, ids.size === 0 ? null : JSON.stringify([...ids]));
  if (saved) window.dispatchEvent(new Event(PREVIEWS_CHANGED));
  return saved;
}

export function useSetWorkspacePreviewHidden(): (
  workspace: { readonly id: string; readonly name: string },
  hidden: boolean,
) => boolean {
  const undo = useUndo();

  function save(workspaceId: string, hidden: boolean): boolean {
    if (setWorkspacePreviewHidden(workspaceId, hidden)) return true;
    publishNotice({
      key: 'workspace-preview-storage',
      message: 'This browser could not save your Quick previews preference.',
    });
    return false;
  }

  return (workspace, hidden) => {
    if (!save(workspace.id, hidden)) return false;
    undo.push(`${workspace.name} ${hidden ? 'hidden from' : 'shown in'} Quick previews`, () => {
      save(workspace.id, !hidden);
    });
    return true;
  };
}

export function rememberLastWorkspaceId(workspaceId: string): void {
  // Workspace selection still works when browser persistence is unavailable.
  writeStored(LAST_WORKSPACE_KEY, workspaceId);
  const visits = workspaceVisits(readVisits());
  const count = visits.find((entry) => entry.id === workspaceId)?.count ?? 0;
  const next = [
    { id: workspaceId, count: Math.min(count + 1, Number.MAX_SAFE_INTEGER) },
    ...visits.filter((entry) => entry.id !== workspaceId),
  ];
  if (writeStored(RECENT_KEY, JSON.stringify(next)))
    window.dispatchEvent(new Event(PREVIEWS_CHANGED));
}
