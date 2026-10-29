import { type CellRange } from '@nix/sheet';
import type { ClipboardEvent } from 'react';

import { type Item } from '@nix/web-collections/core/container-model';
import { parseTsv, rangeToTsv } from '@nix/web-collections/sheet/clipboard';
import { type PlanVerb } from './grid-geometry';
import { pastePlan, rangeTextMap, type SpreadsheetColumn, type WritePlan } from './grid-model';

/** The grid's copy and paste handlers; both do nothing while a cell is being edited. */
export function gridClipboardHandlers(
  items: readonly Item[],
  columns: readonly SpreadsheetColumn[],
  range: CellRange,
  editing: boolean,
  setNotice: (notice: string | null) => void,
  applyPlan: (plan: WritePlan, verb: PlanVerb) => void,
): {
  readonly onCopy: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
} {
  return {
    onCopy: (event) => {
      if (editing) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData(
        'text/plain',
        rangeToTsv(rangeTextMap(range, items, columns), range),
      );
      const copied = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
      setNotice(copied === 1 ? 'Copied 1 cell.' : `Copied ${String(copied)} cells.`);
    },
    onPaste: (event) => {
      if (editing) {
        return;
      }
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (text.length > 0) {
        applyPlan(
          pastePlan({ row: range.startRow, col: range.startCol }, parseTsv(text), items, columns),
          'taken',
        );
      }
    },
  };
}
