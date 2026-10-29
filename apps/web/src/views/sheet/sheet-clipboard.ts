import { cellKey, type CellRange } from '@nix/sheet';
import type { ClipboardEvent } from 'react';

import { parseTsv, rangeToTsv } from '../../collections/sheet/clipboard';
import { type SheetData } from './use-sheet';

/**
 * The grid's copy, cut and paste handlers. While a cell is being edited the native input handles
 * the clipboard, so each does nothing then. `setNotice` receives what the action did, for the
 * live region.
 */
export function sheetClipboardHandlers(
  sheet: SheetData,
  range: CellRange,
  rangeLabel: string,
  editing: boolean,
  setNotice: (notice: string) => void,
): {
  readonly onCopy: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onCut: (event: ClipboardEvent<HTMLDivElement>) => void;
  readonly onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
} {
  return {
    onCopy: (event) => {
      if (editing) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
      setNotice(`Copied ${rangeLabel}`);
    },
    onCut: (event) => {
      if (editing) {
        return;
      }
      event.preventDefault();
      event.clipboardData.setData('text/plain', rangeToTsv(sheet.cells, range));
      sheet.clearRange(range);
      setNotice(`Cut ${rangeLabel}`);
    },
    onPaste: (event) => {
      if (editing) {
        return;
      }
      event.preventDefault();
      const text = event.clipboardData.getData('text/plain');
      if (text.length > 0) {
        sheet.pasteBlock({ row: range.startRow, col: range.startCol }, parseTsv(text));
        setNotice(`Pasted at ${cellKey({ row: range.startRow, col: range.startCol })}`);
      }
    },
  };
}
