import type { KeyboardEvent, RefObject } from 'react';

import type { OutlineRow } from './outline-model';
import type { OutlineTreeState } from './use-outline-tree';

/**
 * The tree's keyboard: Up/Down/Home/End move, Right/Left open and close, Tab and Shift+Tab
 * reparent, Ctrl/Cmd+Up/Down reorder, F2 renames, Enter adds a sibling. Escape releases the next Tab.
 */
export function onRowKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  row: OutlineRow,
  tree: OutlineTreeState,
  releaseTab: RefObject<boolean>,
  onOpen: (itemId: string) => void,
): void {
  const { rows, busy, expanded } = tree;
  const modifier = event.metaKey || event.ctrlKey;
  const position = rows.indexOf(row);

  if (event.key === 'Tab') {
    if (releaseTab.current) {
      releaseTab.current = false;
      return;
    }
    event.preventDefault();
    if (busy) return;
    void (event.shiftKey ? tree.outdent(row) : tree.indent(row));
    return;
  }
  releaseTab.current = false;

  // The sidebar tree's bindings work here too, so the hands that move rows there move them here.
  if (event.altKey && !modifier) {
    const action: Record<string, (() => void) | undefined> = {
      ArrowUp: () => void tree.reorder(row, -1),
      ArrowDown: () => void tree.reorder(row, 1),
      ArrowRight: () => void tree.indent(row),
      ArrowLeft: () => void tree.outdent(row),
      Enter: () => {
        onOpen(row.item.id);
      },
    };
    const run = action[event.key];
    if (run !== undefined) {
      event.preventDefault();
      if (!busy || event.key === 'Enter') run();
      return;
    }
  }

  switch (event.key) {
    case 'Escape':
      // The way out: the next Tab leaves the tree instead of indenting. Claimed, so the same
      // press does not also leave Zen mode or close whatever the outline sits in.
      event.preventDefault();
      event.stopPropagation();
      releaseTab.current = true;
      return;
    case 'ArrowDown':
      event.preventDefault();
      if (modifier) {
        if (!busy) void tree.reorder(row, 1);
      } else {
        tree.focusRow(rows[position + 1]?.item.id);
      }
      return;
    case 'ArrowUp':
      event.preventDefault();
      if (modifier) {
        if (!busy) void tree.reorder(row, -1);
      } else {
        tree.focusRow(rows[position - 1]?.item.id);
      }
      return;
    case 'ArrowRight':
      event.preventDefault();
      if (!row.item.hasChildren) return;
      if (expanded.has(row.item.id)) {
        tree.focusRow(rows[position + 1]?.item.id);
      } else {
        void tree.open(row.item);
      }
      return;
    case 'ArrowLeft':
      event.preventDefault();
      if (expanded.has(row.item.id)) {
        tree.close(row.item);
      } else {
        tree.focusRow(row.parentId ?? undefined);
      }
      return;
    case 'Home':
      event.preventDefault();
      tree.focusRow(rows[0]?.item.id);
      return;
    case 'End':
      event.preventDefault();
      tree.focusRow(rows[rows.length - 1]?.item.id);
      return;
    case 'F2':
      event.preventDefault();
      tree.startRename(row.item.id);
      return;
    case 'Enter':
      event.preventDefault();
      if (modifier) {
        onOpen(row.item.id);
      } else {
        tree.setDraft({ parentId: row.parentId, afterId: row.item.id, level: row.level });
      }
      return;
    default:
      return;
  }
}
