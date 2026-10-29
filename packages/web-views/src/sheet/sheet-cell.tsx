import { type CellValue, formatCellValue, isSheetError } from '@nix/sheet';
import { gridRangeCell } from '@nix/ui';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

import { fitCellText } from './overflow';

export interface SheetCellProps {
  readonly cellKey: string;
  readonly col: number;
  readonly value: CellValue | undefined;
  readonly raw: string | undefined;
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly inRange: boolean;
  readonly isActive: boolean;
  readonly onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

/** One windowed gridcell: its text, its disclosure title and its selection styling. */
export function SheetCell({
  cellKey: key,
  col,
  value,
  raw,
  top,
  left,
  width,
  height,
  inRange,
  isActive,
  onMouseDown,
  onDoubleClick,
}: SheetCellProps): ReactNode {
  const display = value === undefined ? '' : formatCellValue(value);
  const failed = value !== undefined && isSheetError(value);
  const numeric = typeof value === 'number';
  // A number that does not fit shows hash marks, never a
  // digit prefix that reads as a smaller number. The label
  // keeps the real value, so assistive technology hears it
  // and the hover reveals it.
  const shown = fitCellText(display, numeric, width);
  const overflowed = shown !== display;
  // The hover disclosure, most specific first: a hashed
  // formula cell shows its value and its formula, a hashed
  // literal its value, a fitting formula its raw text.
  let titleText: string | undefined;
  if (overflowed) {
    titleText = raw !== undefined && raw !== display ? `${display} (${raw})` : display;
  } else if (raw !== undefined && raw !== display) {
    titleText = raw;
  }
  // design-token-exempt: a cell's place and size are grid geometry computed at runtime
  const cellStyle = {
    top: `${String(top)}px`,
    left: `${String(left)}px`,
    width: `${String(width)}px`,
    height: `${String(height)}px`,
  };
  // Justification: this grid uses aria-activedescendant, where focus stays on the
  // role="grid" container and the active cell is only named, not focused. A
  // tabIndex here would let Tab escape into individual cells and break that
  // pattern.
  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      id={`sheet-cell-${key}`}
      data-sheet-cell={key}
      role="gridcell"
      aria-colindex={col + 1}
      aria-selected={isActive || inRange}
      aria-label={`${key}${display.length > 0 ? `, ${display}` : ''}`}
      title={titleText}
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      // px-2 here is the box overflow.ts's
      // CELL_HORIZONTAL_PADDING describes - change both.
      className={`absolute overflow-hidden text-ellipsis border-b border-r border-divider px-2 py-1.5 text-sm whitespace-nowrap ${
        numeric ? 'text-right' : 'text-left'
      } ${failed ? 'font-semibold underline decoration-dotted decoration-2' : ''} ${
        inRange ? gridRangeCell : ''
      } ${isActive ? 'outline-2 -outline-offset-2 outline-accent' : ''}`}
      style={cellStyle}
    >
      {shown}
    </div>
  );
}
