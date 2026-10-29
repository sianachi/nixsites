import { cellKey, rangeContains, type CellRange, type CellRef } from '@nix/sheet';
import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { SheetCell } from './sheet-cell';
import { type SheetData } from './use-sheet';

/** The windowed rows and cells: only the indices passed in exist in the DOM. */
export function SheetCellRows({
  sheet,
  visibleRows,
  visibleCols,
  rowHeight,
  offsets,
  widths,
  defaultWidth,
  range,
  rangeIsCell,
  active,
  onCellMouseDown,
  onCellOpen,
}: {
  readonly sheet: SheetData;
  readonly visibleRows: readonly number[];
  readonly visibleCols: readonly number[];
  readonly rowHeight: number;
  readonly offsets: readonly number[];
  readonly widths: readonly number[];
  readonly defaultWidth: number;
  readonly range: CellRange;
  readonly rangeIsCell: boolean;
  readonly active: CellRef;
  readonly onCellMouseDown: (
    row: number,
    col: number,
    raw: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => void;
  /** A double-click: opens the cell's raw text for editing. */
  readonly onCellOpen: (raw: string) => void;
}): ReactNode {
  return visibleRows.map((row) => (
    <div key={row} role="row" aria-rowindex={row + 1} className="contents">
      {visibleCols.map((col) => {
        const key = cellKey({ row, col });
        const raw = sheet.cells.get(key);
        return (
          <SheetCell
            key={col}
            cellKey={key}
            col={col}
            value={sheet.values.get(key)}
            raw={raw}
            top={row * rowHeight}
            left={offsets[col] ?? 0}
            width={widths[col] ?? defaultWidth}
            height={rowHeight}
            inRange={!rangeIsCell && rangeContains(range, { row, col })}
            isActive={row === active.row && col === active.col}
            onMouseDown={(event) => {
              onCellMouseDown(row, col, raw ?? '', event);
            }}
            onDoubleClick={() => {
              onCellOpen(raw ?? '');
            }}
          />
        );
      })}
    </div>
  ));
}
