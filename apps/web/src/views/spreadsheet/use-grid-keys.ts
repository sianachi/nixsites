import { type CellRange, type CellRef } from '@nix/sheet';
import { useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { type Item } from '@nix/web-collections/core/container-model';
import { gridKeyAction } from '@nix/web-collections/sheet/grid-keys';
import {
  type GridBounds,
  type SelectionAction,
  type SelectionState,
} from '@nix/web-collections/sheet/selection';
import { type PlanVerb } from './grid-geometry';
import {
  cellText,
  clearPlan,
  fillPlan,
  seriesFillPlan,
  type SpreadsheetColumn,
  type WritePlan,
} from './grid-model';

interface GridKeysArgs {
  readonly items: readonly Item[];
  readonly columns: readonly SpreadsheetColumn[];
  readonly selection: SelectionState;
  readonly dispatch: Dispatch<SelectionAction>;
  readonly bounds: GridBounds;
  readonly active: CellRef;
  readonly range: CellRange;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly applyPlan: (plan: WritePlan, verb: PlanVerb) => void;
  readonly beginEdit: (source: 'typing' | 'open', draft: string) => void;
  readonly setNotice: (notice: string | null) => void;
}

/** The grid's keyboard model: the shared ladder plus fill down and fill series. */
export function useGridKeys(args: GridKeysArgs): {
  onGridKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  fillSeries: () => boolean;
} {
  const {
    items,
    columns,
    selection,
    dispatch,
    bounds,
    active,
    range,
    viewportHeight,
    rowHeight,
    applyPlan,
    beginEdit,
    setNotice,
  } = args;
  const activeColumn = columns[active.col];
  const activeItem = items[active.row];

  // Whether Tab is a cell movement or an exit. Escape releases the trap and any grid keystroke
  // restores it - blurring on Escape, which this replaced, sent focus to <body>, so the promised
  // "Escape, then Tab" resumed from the top of the document instead of from after the grid.
  const [trapsTab, setTrapsTab] = useState(true);

  function isOccupied(ref: CellRef): boolean {
    const item = items[ref.row];
    const column = columns[ref.col];
    return item !== undefined && column !== undefined && cellText(item, column).length > 0;
  }

  /**
   * Builds and applies the series fill for the current selection: the full plan, every value
   * coerced, computed here rather than on render because only the click and the shortcut need it.
   */
  function fillSeries(): boolean {
    const fill = range.endRow > range.startRow ? seriesFillPlan(range, items, columns) : null;
    if (fill === null || fill.rows === 0) {
      return false;
    }
    applyPlan(fill.plan, 'filled');
    return true;
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (selection.mode === 'edit') {
      return;
    }
    // Cleared first so a repeated, identical notice (a second copy) changes the live region again.
    setNotice(null);
    if (event.key === 'Escape') {
      // Escape releases the Tab trap; the next Tab then leaves the grid in document order, which
      // is what the hint promises.
      event.preventDefault();
      setTrapsTab(false);
      return;
    }
    if (event.key === 'Tab' && !trapsTab) {
      return;
    }
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.shiftKey && (event.key === 'd' || event.key === 'D')) {
      // Fill by pattern: each selected column continued from the filled cells at its top - the
      // series `seriesFillPlan` finds, or the last value repeated when there is none. Shift is the
      // only difference from the plain fill below, which copies the first row verbatim.
      event.preventDefault();
      setTrapsTab(true);
      if (!fillSeries()) {
        setNotice(
          'Select a column with filled cells at the top and rows below them to continue a series.',
        );
      }
      return;
    }

    if (meta && (event.key === 'd' || event.key === 'D')) {
      // Fill down: the range's first row repeated over the rows below it - the fill the goal
      // names, on the incumbents' own key. On a single cell there is nothing below the pattern,
      // and silence would be indistinguishable from breakage.
      event.preventDefault();
      setTrapsTab(true);
      if (range.endRow === range.startRow) {
        setNotice('Select rows to fill down: the first row of the selection is the pattern.');
      } else {
        applyPlan(fillPlan(range, items, columns), 'filled');
      }
      return;
    }

    // Everything else is the ladder both grids share; only what the result means - what a clear
    // clears, what text an opened edit starts from - is this grid's own.
    const result = gridKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        meta,
        isComposing: event.nativeEvent.isComposing,
      },
      {
        active,
        bounds,
        pageRows: Math.max(1, Math.floor(viewportHeight / rowHeight) - 1),
        isOccupied,
      },
    );
    if (result === null) {
      return;
    }

    event.preventDefault();
    setTrapsTab(true);
    switch (result.kind) {
      case 'action':
        dispatch(result.action);
        return;
      case 'edit':
        beginEdit(
          result.source,
          result.source === 'typing'
            ? result.draft
            : activeItem !== undefined && activeColumn !== undefined
              ? cellText(activeItem, activeColumn)
              : '',
        );
        return;
      case 'clear':
        applyPlan(clearPlan(range, items, columns), 'cleared');
    }
  }

  return { onGridKeyDown, fillSeries };
}
