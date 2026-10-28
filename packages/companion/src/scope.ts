import { z } from 'zod';
import { items, structure, type Item } from '@nix/api-client';
import type { CompanionPorts } from './ports.js';
import { checkItem } from './guards.js';
import { listedItems } from './read/list-items.js';
import { READ_ONLY_OPERATIONS, WorkspaceToolRefusal, type WorkspaceToolArgs } from './tool-args.js';

export interface NoteToolScope {
  rootItemId: string;
  readOnly: boolean;
}

const MAX_ANCESTORS = 128;
const MAX_SEARCH_ITEMS = 500;
const MAX_RESULTS = 50;

/** New operations need an explicit subtree check before becoming available to note chats. */
const SCOPED_OPERATIONS: ReadonlySet<WorkspaceToolArgs['operation']> = new Set([
  'list_items',
  'search',
  'read_item',
  'read_note',
  'search_note',
  'read_structure',
  'create_note',
  'append_note',
  'replace_section',
  'replace_passage',
  'rename_item',
  'move_item',
  'set_properties',
  'trash_item',
  'create_structured',
  'add_view',
  'update_view',
  'create_entries',
  'add_fields',
  'edit_fields',
  'edit_form',
  'set_recurrence',
]);

export async function checkNoteScopedItem(
  ports: CompanionPorts,
  workspaceId: string,
  itemId: string,
  signal: AbortSignal,
  scope: NoteToolScope,
): Promise<Item> {
  const item = await checkItem(ports, workspaceId, itemId, signal);
  if (item.id !== itemId)
    throw new WorkspaceToolRefusal('The item identity could not be confirmed. No action was run.');
  let current = item;
  const visited = new Set<string>();
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    if (current.id === scope.rootItemId) return item;
    if (!current.parentId || visited.has(current.id)) break;
    visited.add(current.id);
    const parentId = current.parentId;
    current = await checkItem(ports, workspaceId, parentId, signal);
    if (current.id !== parentId)
      throw new WorkspaceToolRefusal(
        'The item ancestry could not be confirmed. No action was run.',
      );
  }
  throw new WorkspaceToolRefusal(
    'This conversation can only use the selected note and its children. The item is outside that note, or its ancestry could not be confirmed. No action was run.',
  );
}

/** Restricts the user's chosen context; Core still authorizes every request as the user. */
export async function prepareNoteScopedTool(
  ports: CompanionPorts,
  workspaceId: string,
  args: WorkspaceToolArgs,
  signal: AbortSignal,
  scope: NoteToolScope,
): Promise<WorkspaceToolArgs> {
  z.uuid().parse(scope.rootItemId);
  if (scope.readOnly && !READ_ONLY_OPERATIONS.has(args.operation))
    throw new WorkspaceToolRefusal('This note conversation is read only. No changes were made.');
  if (!SCOPED_OPERATIONS.has(args.operation))
    throw new WorkspaceToolRefusal(
      'This operation cannot be limited to the selected note and its children. Use the workspace conversation for this request.',
    );
  await checkNoteScopedItem(ports, workspaceId, scope.rootItemId, signal, scope);
  const prepared =
    !args.parentId && ['list_items', 'create_note', 'create_structured'].includes(args.operation)
      ? { ...args, parentId: scope.rootItemId }
      : args;
  if (prepared.itemId)
    await checkNoteScopedItem(ports, workspaceId, prepared.itemId, signal, scope);
  if (prepared.parentId)
    await checkNoteScopedItem(ports, workspaceId, prepared.parentId, signal, scope);
  if (
    prepared.operation === 'move_item' &&
    (!prepared.parentId || prepared.itemId === scope.rootItemId)
  )
    throw new WorkspaceToolRefusal(
      'A note conversation cannot move its root or move an item outside its children. No changes were made.',
    );
  return prepared;
}

export async function listNoteScopedItems(
  ports: CompanionPorts,
  workspaceId: string,
  parentId: string,
  signal: AbortSignal,
  scope: NoteToolScope,
): Promise<{ result: ReturnType<typeof listedItems>; contentSources: string[] }> {
  await checkNoteScopedItem(ports, workspaceId, parentId, signal, scope);
  const requestOptions = { signal, forceRefresh: true };
  const children: Item[] = [];
  let truncated = false;
  for await (const listed of ports.core.paginate(
    items.listItems(workspaceId, { parentId, pageSize: MAX_RESULTS }),
    requestOptions,
  )) {
    if (children.length >= MAX_RESULTS) {
      truncated = true;
      break;
    }
    const child = await checkNoteScopedItem(ports, workspaceId, listed.id, signal, scope);
    if (child.parentId !== parentId)
      throw new WorkspaceToolRefusal('The note tree changed while listing it. Try again.');
    children.push(child);
  }
  const fields = (await ports.core.query(structure.effectiveSchema(parentId), requestOptions))
    .properties;
  return {
    result: listedItems(children, fields, truncated),
    contentSources: children.map((x) => x.id),
  };
}

interface NoteTitleSearch {
  results: Pick<Item, 'id' | 'workspaceId' | 'title' | 'type'>[];
  scanned: number;
  truncated: boolean;
  partial: boolean;
  titlesOnly: true;
  hint: string;
}

export async function searchNoteScopedItems(
  ports: CompanionPorts,
  workspaceId: string,
  query: string,
  signal: AbortSignal,
  scope: NoteToolScope,
): Promise<{ result: NoteTitleSearch; contentSources: string[] }> {
  const term = query.trim();
  if (!term) throw new WorkspaceToolRefusal('A search query is required.');
  const root = await checkNoteScopedItem(ports, workspaceId, scope.rootItemId, signal, scope);
  const results: NoteTitleSearch['results'] = [];
  const contentSources: string[] = [];
  const add = (item: Item) => {
    contentSources.push(item.id);
    // shortcut: only titles are searched, include bodies when Core offers a subtree search.
    if (!item.title.toLowerCase().includes(term.toLowerCase())) return;
    results.push({
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      type: item.type,
    });
  };
  if (z.uuid().safeParse(term).success) {
    const item = await checkNoteScopedItem(ports, workspaceId, term, signal, scope);
    results.push({
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      type: item.type,
    });
    contentSources.push(item.id);
    return {
      result: {
        results,
        scanned: 1,
        truncated: false,
        partial: false,
        titlesOnly: true,
        hint: 'Resolved an item identity inside this note. Note bodies were not searched.',
      },
      contentSources,
    };
  }
  add(root);
  const pending = [root.id];
  const visited = new Set(pending);
  let scanned = 1;
  let truncated = false;
  for (let index = 0; index < pending.length && !truncated; index += 1) {
    const parentId = pending[index];
    if (parentId === undefined) break;
    await checkNoteScopedItem(ports, workspaceId, parentId, signal, scope);
    for await (const listed of ports.core.paginate(
      items.listItems(workspaceId, { parentId, pageSize: MAX_RESULTS }),
      { signal, forceRefresh: true },
    )) {
      if (scanned >= MAX_SEARCH_ITEMS || results.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
      if (visited.has(listed.id))
        throw new WorkspaceToolRefusal('The note tree could not be confirmed. Try again.');
      const child = await checkNoteScopedItem(ports, workspaceId, listed.id, signal, scope);
      if (child.parentId !== parentId)
        throw new WorkspaceToolRefusal('The note tree changed while searching it. Try again.');
      visited.add(child.id);
      scanned += 1;
      add(child);
      if (child.hasChildren) pending.push(child.id);
    }
  }
  return {
    result: {
      results,
      scanned,
      truncated,
      partial: truncated,
      titlesOnly: true,
      hint: truncated
        ? 'Only titles in the first 500 items or first 50 matches were searched. Open a smaller note for a complete search. Note bodies were not searched.'
        : 'Searched note titles only. Note bodies were not searched.',
    },
    contentSources,
  };
}
