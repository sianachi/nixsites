import { useUndo } from '@nix/ui';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { onItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { sortItems, type Item } from '@nix/web-collections/core/container-model';
import type { ContainerData } from '@nix/web-collections/core/use-container';
import { titleOf, without, type Draft, type OutlineRow, type RowNote } from './outline-model';
import { describeOutlineRefusal, isLockedRead, type OutlineSource } from './outline-source';

export interface OutlineTreeState {
  readonly rootId: string | null;
  readonly rows: readonly OutlineRow[];
  readonly activeId: string | null;
  readonly activeRow: OutlineRow | null;
  readonly expanded: ReadonlySet<string>;
  readonly loading: ReadonlySet<string>;
  readonly locked: ReadonlySet<string>;
  readonly note: RowNote | null;
  readonly draft: Draft | null;
  readonly busy: boolean;
  readonly renamingId: string | null;
  readonly rowRefs: RefObject<Map<string, HTMLDivElement>>;
  readonly setFocusedId: (id: string | null) => void;
  readonly setDraft: (draft: Draft | null) => void;
  readonly open: (item: Item) => Promise<void>;
  readonly close: (item: Item) => void;
  readonly indent: (row: OutlineRow) => Promise<void>;
  readonly outdent: (row: OutlineRow) => Promise<void>;
  readonly reorder: (row: OutlineRow, by: -1 | 1) => Promise<void>;
  readonly add: (title: string, at: Draft) => Promise<string | null>;
  readonly focusRow: (id: string | undefined) => void;
  readonly cancelDraft: () => void;
  readonly startRename: (id: string) => void;
  readonly rename: (row: OutlineRow, title: string) => Promise<void>;
  readonly cancelRename: (id: string) => void;
  /** The row the last edit was about and how, so that row can confirm it where it happened. */
  readonly edit: RowEdit | null;
  /** The row being dragged and the row it is over, for the drop mark. */
  readonly drag: DragState | null;
  readonly setDrag: (drag: DragState | null) => void;
  /** Drops `row` above or below `target`, or inside it when it is open and the drop is below. */
  readonly dropOn: (row: OutlineRow, target: OutlineRow, before: boolean) => Promise<void>;
  /** Tuck the next new item under the row above it; resolves to a refusal to show, or null. */
  readonly indentDraft: (text: string) => Promise<string | null>;
  readonly outdentDraft: (text: string) => string | null;
}

export interface RowEdit {
  readonly id: string;
  readonly kind: 'move' | 'add' | 'rename';
  readonly n: number;
}

export interface DragState {
  readonly id: string;
  readonly overId: string | null;
  readonly before: boolean;
}

/**
 * The outline's state and its structural edits: which rows are open, the one-level reads behind
 * them, and every move, indent, outdent, reorder and add, each refused or accepted by the server.
 */
export function useOutlineTree(container: ContainerData, source: OutlineSource): OutlineTreeState {
  const rootId = container.itemId;
  const [nested, setNested] = useState<ReadonlyMap<string, readonly Item[]>>(() => new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(() => new Set());
  const [locked, setLocked] = useState<ReadonlySet<string>>(() => new Set());
  const [note, setNote] = useState<RowNote | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<RowEdit | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const undo = useUndo();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocus = useRef<string | null>(null);

  // Focus follows the row the last edit was about, once the re-read that moved it has rendered. A
  // ref rather than state: it is an instruction to the next render, not something to draw.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    const element = rowRefs.current.get(target);
    if (element !== undefined) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  // Somebody else's edit - the sidebar, another tab of this app, a pet - can change a level this
  // outline has already read. Each opened level is re-read when its children are said to change;
  // the top level is the container's own and reloads itself.
  const nestedRef = useRef(nested);
  useEffect(() => {
    nestedRef.current = nested;
  }, [nested]);
  useEffect(
    () =>
      onItemChildrenChanged((detail) => {
        const parents =
          detail.parentId === null ? [...nestedRef.current.keys()] : [detail.parentId];
        for (const parentId of parents) {
          if (!nestedRef.current.has(parentId)) continue;
          void source
            .list(parentId)
            .then((children) => {
              setNested((current) =>
                new Map(current).set(parentId, sortItems(children, null, false)),
              );
            })
            .catch(() => undefined);
        }
      }),
    [source],
  );

  const roots = sortItems(container.children, null, false);
  // A root reload can arrive before cached children after an outdent.
  const rootIds = new Set(roots.map((item) => item.id));
  const childrenOf = (parentId: string | null): readonly Item[] =>
    parentId === rootId
      ? roots
      : parentId === null
        ? []
        : (nested.get(parentId) ?? []).filter((item) => !rootIds.has(item.id));

  const rows: OutlineRow[] = [];
  const walk = (parentId: string | null, level: number): void => {
    const siblings = childrenOf(parentId);
    siblings.forEach((item, index) => {
      rows.push({ item, level, parentId, siblings, index });
      if (expanded.has(item.id)) walk(item.id, level + 1);
    });
  };
  walk(rootId, 1);

  const activeId =
    focusedId !== null && rows.some((row) => row.item.id === focusedId)
      ? focusedId
      : (rows[0]?.item.id ?? null);
  const activeRow = rows.find((row) => row.item.id === activeId) ?? null;

  function flashEdit(id: string, kind: RowEdit['kind']): void {
    setEdit((current) => ({ id, kind, n: (current?.n ?? 0) + 1 }));
  }

  // Undo runs later, from whatever the screen is then: it re-reads through the latest closure.
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  /** Re-reads one parent's children: the container's own for the top level, a read otherwise. */
  async function refresh(parentId: string | null): Promise<void> {
    if (parentId === rootId) {
      await container.reload();
      return;
    }
    if (parentId === null) return;
    const children = await source.list(parentId);
    setNested((current) => new Map(current).set(parentId, sortItems(children, null, false)));
  }

  async function open(item: Item): Promise<void> {
    setExpanded((current) => new Set(current).add(item.id));
    if (nested.has(item.id)) return;
    setLoading((current) => new Set(current).add(item.id));
    try {
      const children = await source.list(item.id);
      setNested((current) => new Map(current).set(item.id, sortItems(children, null, false)));
      setLocked((current) => without(current, item.id));
    } catch (reason) {
      setExpanded((current) => without(current, item.id));
      if (isLockedRead(reason)) {
        setLocked((current) => new Set(current).add(item.id));
        setNote({
          itemId: item.id,
          text: 'This is locked. Unlock it from its own page to see inside.',
        });
      } else {
        setNote({ itemId: item.id, text: describeOutlineRefusal(reason) });
      }
    } finally {
      setLoading((current) => without(current, item.id));
    }
  }

  function close(item: Item): void {
    setExpanded((current) => without(current, item.id));
  }

  /**
   * One structural edit: the move, then a re-read of every parent it touched, with focus kept on
   * the moved row. A refusal is said under the row and nothing on screen moves.
   */
  async function move(
    row: OutlineRow,
    parentId: string | null,
    afterId: string | null,
    label: string,
  ): Promise<boolean> {
    setNote(null);
    const originalAfter = row.siblings[row.index - 1]?.id ?? null;
    setBusy(true);
    try {
      try {
        await source.move(row.item.id, row.parentId, parentId, afterId);
      } catch (reason) {
        setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
        return false;
      }
      pendingFocus.current = row.item.id;
      flashEdit(row.item.id, 'move');
      // One entry puts it back where it was from the current state, not from a snapshot.
      undo.push(label, async () => {
        try {
          await source.move(row.item.id, parentId, row.parentId, originalAfter);
        } catch (reason) {
          setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
          return;
        }
        pendingFocus.current = row.item.id;
        flashEdit(row.item.id, 'move');
        await Promise.all(
          [...new Set([row.parentId, parentId])].map((parent) => refreshRef.current(parent)),
        ).catch(() => undefined);
      });
      // The move happened; a failed re-read is a different sentence from a refused move, because
      // retrying the move would move it again.
      try {
        await Promise.all([...new Set([row.parentId, parentId])].map((parent) => refresh(parent)));
      } catch {
        setNote({
          itemId: row.item.id,
          text: 'Moved, but this outline could not be re-read. Reload the page to see where it is now.',
        });
      }
      return true;
    } finally {
      setBusy(false);
    }
  }

  async function childrenToAppendTo(above: Item): Promise<readonly Item[] | undefined> {
    const known = nested.get(above.id);
    if (known !== undefined || !above.hasChildren) return known;
    return sortItems(await source.list(above.id), null, false);
  }

  async function indent(row: OutlineRow): Promise<void> {
    const above = row.siblings[row.index - 1];
    if (above === undefined) {
      setNote({ itemId: row.item.id, text: 'There is nothing above this to move it into.' });
      return;
    }
    if (above.noChildren === true) {
      setNote({
        itemId: row.item.id,
        text: `"${titleOf(above)}" does not accept new children.`,
      });
      return;
    }
    // Last among the new parent's children, which means knowing them: read them first if the row
    // above has never been opened, rather than guessing "first" and landing it out of order.
    let children: readonly Item[] | undefined;
    try {
      children = await childrenToAppendTo(above);
    } catch (reason) {
      setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
      return;
    }
    const last = children?.[children.length - 1];
    const label = `Indented "${titleOf(row.item)}" under "${titleOf(above)}"`;
    if (await move(row, above.id, last?.id ?? null, label)) {
      setExpanded((current) => new Set(current).add(above.id));
    }
  }

  async function outdent(row: OutlineRow): Promise<void> {
    if (row.parentId === rootId || row.parentId === null) {
      setNote({ itemId: row.item.id, text: 'This is already at the top of this outline.' });
      return;
    }
    const parentRow = rows.find((candidate) => candidate.item.id === row.parentId);
    if (parentRow === undefined) return;
    await move(
      row,
      parentRow.parentId,
      parentRow.item.id,
      `Outdented "${titleOf(row.item)}" out of "${titleOf(parentRow.item)}"`,
    );
  }

  function moved(row: OutlineRow, direction: 'up' | 'down'): string {
    const place = direction === 'up' ? row.index : row.index + 2;
    return `Moved "${titleOf(row.item)}" ${direction} to ${String(place)} of ${String(row.siblings.length)}`;
  }

  async function reorder(row: OutlineRow, by: -1 | 1): Promise<void> {
    if (by === -1) {
      if (row.index === 0) return;
      const before = row.siblings[row.index - 2];
      await move(row, row.parentId, before?.id ?? null, moved(row, 'up'));
      return;
    }
    const after = row.siblings[row.index + 1];
    if (after === undefined) return;
    await move(row, row.parentId, after.id, moved(row, 'down'));
  }

  async function dropOn(row: OutlineRow, target: OutlineRow, before: boolean): Promise<void> {
    setDrag(null);
    if (row.item.id === target.item.id) return;
    const into = !before && expanded.has(target.item.id) && target.item.hasChildren;
    const parentId = into ? target.item.id : target.parentId;
    const afterId = into
      ? null
      : before
        ? (target.siblings[target.index - 1]?.id ?? null)
        : target.item.id;
    // Dropping where it already sits is not an edit.
    if (
      parentId === row.parentId &&
      (afterId === row.item.id || afterId === (row.siblings[row.index - 1]?.id ?? null))
    )
      return;
    const where = into ? 'into' : before ? 'above' : 'below';
    await move(
      row,
      parentId,
      afterId,
      `Moved "${titleOf(row.item)}" ${where} "${titleOf(target.item)}"`,
    );
  }

  /** Makes a sibling from the draft field, then keeps the field open after it for the next one. */
  async function add(title: string, at: Draft): Promise<string | null> {
    setNote(null);
    let created: Item;
    try {
      created = await source.create(at.parentId, title);
    } catch (reason) {
      // Nothing was made, so the name goes back into the field for another go.
      return describeOutlineRefusal(reason);
    }
    // From here the item exists. Whatever else fails, the draft moves past it and the name is not
    // put back, so a retry can never make it twice.
    const siblings = childrenOf(at.parentId);
    const last = siblings[siblings.length - 1];
    let placementRefused: string | null = null;
    // A create lands last among its siblings; only a sibling added mid-list needs a move.
    if (at.afterId !== null && at.afterId !== last?.id) {
      try {
        await source.move(created.id, at.parentId, at.parentId, at.afterId);
      } catch (reason) {
        placementRefused = `Added at the end instead: ${describeOutlineRefusal(reason)}`;
      }
    }
    try {
      await refresh(at.parentId);
    } catch {
      placementRefused ??= 'Added, but this outline could not be re-read. Reload to see it.';
    }
    setDraft({ parentId: at.parentId, afterId: created.id, level: at.level });
    setFocusedId(created.id);
    flashEdit(created.id, 'add');
    if (placementRefused !== null) setNote({ itemId: created.id, text: placementRefused });
    return null;
  }

  function startRename(id: string): void {
    setNote(null);
    setFocusedId(id);
    setRenamingId(id);
  }

  function cancelRename(id: string): void {
    setRenamingId(null);
    pendingFocus.current = id;
    setFocusedId(id);
  }

  /** Renames in place; an empty or unchanged title is a cancel, a refusal is said on the row. */
  async function rename(row: OutlineRow, title: string): Promise<void> {
    const named = title.trim();
    cancelRename(row.item.id);
    if (named.length === 0 || named === row.item.title) return;
    setNote(null);
    try {
      await source.rename(row.item.id, row.parentId, named);
    } catch (reason) {
      setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
      return;
    }
    flashEdit(row.item.id, 'rename');
    undo.push(`Renamed "${titleOf(row.item)}" to "${named}"`, async () => {
      try {
        await source.rename(row.item.id, row.parentId, row.item.title);
      } catch (reason) {
        setNote({ itemId: row.item.id, text: describeOutlineRefusal(reason) });
        return;
      }
      flashEdit(row.item.id, 'rename');
      await refreshRef.current(row.parentId).catch(() => undefined);
    });
    try {
      await refresh(row.parentId);
    } catch {
      setNote({
        itemId: row.item.id,
        text: 'Renamed, but this outline could not be re-read. Reload to see it.',
      });
    }
  }

  /** Closes the new-item field and puts focus back on the row it followed. */
  function cancelDraft(): void {
    const back = draft?.afterId ?? null;
    setDraft(null);
    if (back !== null) {
      pendingFocus.current = back;
      setFocusedId(back);
    }
  }

  /** Moves the next new item's place in: last child of the row it follows. */
  async function indentDraft(text: string): Promise<string | null> {
    if (draft === null) return null;
    const above = childrenOf(draft.parentId).find((item) => item.id === draft.afterId);
    if (above === undefined) return 'There is nothing above to tuck this under.';
    if (above.noChildren === true) return `"${titleOf(above)}" does not accept new children.`;
    let children: readonly Item[] | undefined;
    try {
      children = await childrenToAppendTo(above);
    } catch (reason) {
      return describeOutlineRefusal(reason);
    }
    if (children !== undefined) {
      const known = children;
      setNested((current) => new Map(current).set(above.id, known));
    }
    setExpanded((current) => new Set(current).add(above.id));
    setDraft({
      parentId: above.id,
      afterId: children?.[children.length - 1]?.id ?? null,
      level: draft.level + 1,
      text,
    });
    return null;
  }

  function outdentDraft(text: string): string | null {
    if (draft === null) return null;
    const parentRow = rows.find((candidate) => candidate.item.id === draft.parentId);
    if (parentRow === undefined) return 'Already at the top level.';
    setDraft({
      parentId: parentRow.parentId,
      afterId: parentRow.item.id,
      level: draft.level - 1,
      text,
    });
    return null;
  }

  function focusRow(id: string | undefined): void {
    if (id === undefined) return;
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  return {
    rootId,
    rows,
    activeId,
    activeRow,
    expanded,
    loading,
    locked,
    note,
    draft,
    busy,
    renamingId,
    rowRefs,
    setFocusedId,
    setDraft,
    open,
    close,
    indent,
    outdent,
    reorder,
    add,
    focusRow,
    cancelDraft,
    startRename,
    rename,
    cancelRename,
    edit,
    drag,
    setDrag,
    dropOn,
    indentDraft,
    outdentDraft,
  };
}
