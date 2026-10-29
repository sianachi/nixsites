import { isEditableTarget } from '@nix/ui';
import { useCallback, useEffect, useState, type RefObject } from 'react';

/**
 * Multi-selection over an ordered list of item ids, shared by every view that offers it.
 *
 * Ported from the drive view so list, gallery, board, checklist and the tree select the same way:
 * a plain toggle per item, Shift extends from the last clicked id across the current order, and
 * selecting never opens or drags. The order is passed on each call rather than stored, because a
 * view's order changes with its sort and filters and a stale copy would range over ghosts.
 */
export interface ItemSelection {
  readonly selected: ReadonlySet<string>;
  readonly toggle: (itemId: string, order: readonly string[], shiftKey?: boolean) => void;
  readonly setAll: (ids: readonly string[]) => void;
  readonly clear: () => void;
  /** Drops ids that are no longer in `order`, for after a move or delete. */
  readonly prune: (order: readonly string[]) => void;
}

export function useItemSelection(): ItemSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);

  const toggle = useCallback(
    (itemId: string, order: readonly string[], shiftKey = false): void => {
      setSelected((current) => {
        const next = new Set(current);
        if (shiftKey && lastClicked !== null) {
          const from = order.indexOf(lastClicked);
          const to = order.indexOf(itemId);
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from];
            for (const id of order.slice(start, end + 1)) next.add(id);
            return next;
          }
        }
        if (next.has(itemId)) next.delete(itemId);
        else next.add(itemId);
        return next;
      });
      setLastClicked(itemId);
    },
    [lastClicked],
  );

  const setAll = useCallback((ids: readonly string[]): void => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback((): void => {
    setSelected(new Set());
    setLastClicked(null);
  }, []);

  const prune = useCallback((order: readonly string[]): void => {
    setSelected((current) => {
      const keep = new Set(order);
      const next = new Set([...current].filter((id) => keep.has(id)));
      return next.size === current.size ? current : next;
    });
  }, []);

  return { selected, toggle, setAll, clear, prune };
}

/** Whether a pointer event asks to select rather than open: Cmd/Ctrl or Shift held. */
export function isSelectGesture(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey;
}

/** What a row's click or key needs from the selection to decide between opening and selecting. */
interface RowSelection {
  readonly selected: ReadonlySet<string>;
  readonly toggle: (itemId: string, order: readonly string[], shiftKey?: boolean) => void;
}

interface RowClickEvent {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** 0 for a click a key produced (Enter on a focused button), 1 and up for a pointer. */
  readonly detail: number;
  readonly preventDefault: () => void;
  readonly nativeEvent: Event;
}

interface RowKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly preventDefault: () => void;
}

/**
 * The one gesture model for a row that both opens and selects: click opens, Cmd/Ctrl-click
 * toggles, Shift-click ranges across `order`, Alt-click opens beside (when the surface can), and
 * Space on the focused control toggles. After a touch long-press has started a selection, a tap
 * toggles too. With no selection (a view drawn alone) a click just opens.
 *
 * With `clickSelects` (open mode none) a plain pointer click selects instead, or does nothing when
 * the view offers no selection; double-click and Enter on the focused control still open.
 */
export function rowGestures(
  selection: RowSelection | null,
  itemId: string,
  order: readonly string[],
  open: () => void,
  openBeside?: () => void,
  clickSelects = false,
): {
  readonly onClick: (event: RowClickEvent) => void;
  readonly onDoubleClick?: () => void;
  readonly onKeyDown: (event: RowKeyEvent) => void;
  readonly onKeyUp: (event: RowKeyEvent) => void;
} {
  return {
    ...(clickSelects ? { onDoubleClick: open } : {}),
    onClick: (event) => {
      if (selection !== null && isSelectGesture(event)) {
        event.preventDefault();
        selection.toggle(itemId, order, event.shiftKey);
      } else if (event.altKey && openBeside !== undefined) {
        openBeside();
      } else if (clickSelects) {
        if (event.detail === 0) open();
        else selection?.toggle(itemId, order);
      } else if (
        selection !== null &&
        selection.selected.size > 0 &&
        (event.nativeEvent as { pointerType?: string }).pointerType === 'touch'
      ) {
        selection.toggle(itemId, order);
      } else {
        open();
      }
    },
    onKeyDown: (event) => {
      if (selection === null || event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey)
        return;
      // Space would otherwise activate the row's button and open it.
      event.preventDefault();
      selection.toggle(itemId, order);
    },
    // Some browsers click a button on Space's keyup whatever keydown did.
    onKeyUp: (event) => {
      if (selection !== null && event.key === ' ') event.preventDefault();
    },
  };
}

/**
 * Keyboard shortcuts for the pane that owns a selection, heard while focus is inside `ref`:
 * Cmd/Ctrl-A selects everything `shown` returns, Escape clears. Escape is only claimed when
 * something is selected, so an empty selection leaves it to whatever it meant before. Text fields
 * keep both keys.
 */
export function useSelectionShortcuts(
  ref: RefObject<HTMLElement | null>,
  selection: Pick<ItemSelection, 'selected' | 'setAll' | 'clear'>,
  shown: () => readonly string[],
): void {
  const { selected, setAll, clear } = selection;
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditableTarget(event.target)) return;
      if (event.key === 'Escape' && selected.size > 0) {
        event.preventDefault();
        clear();
      } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key === 'a') {
        const ids = shown();
        if (ids.length === 0) return;
        event.preventDefault();
        setAll(ids);
      }
    };
    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, selected, setAll, clear, shown]);
}
