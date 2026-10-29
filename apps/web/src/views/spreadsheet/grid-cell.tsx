import { cellKey } from '@nix/sheet';
import { Icon, cn, gridRangeCell } from '@nix/ui';
import { Check, ChevronDown, Square } from 'lucide-react';
import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { type Item } from '../../collections/core/container-model';
import { cellId } from './grid-geometry';
import { TITLE_COLUMN_KEY } from '../../collections/core/columns';
import { cellDisplay, cellText, type SpreadsheetColumn } from './grid-model';

interface GridCellProps {
  readonly gridId: string;
  readonly item: Item;
  readonly column: SpreadsheetColumn;
  readonly row: number;
  readonly col: number;
  readonly rowHeight: number;
  readonly left: number;
  readonly width: number;
  readonly isActive: boolean;
  readonly inRange: boolean;
  readonly onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
}

export function GridCell(props: GridCellProps): ReactNode {
  const {
    gridId,
    item,
    column,
    row,
    col,
    rowHeight,
    isActive,
    inRange,
    onMouseDown,
    onDoubleClick,
  } = props;
  const shown = cellDisplay(item, column);
  const isTitle = column.key === TITLE_COLUMN_KEY;
  // design-token-exempt: a cell's place and size are grid geometry computed at runtime
  const cellStyle = {
    top: `${String(row * rowHeight)}px`,
    left: `${String(props.left)}px`,
    width: `${String(props.width)}px`,
    height: `${String(rowHeight)}px`,
  };

  // Justification: this grid uses aria-activedescendant, where focus stays on the
  // role="grid" container and the active cell is only named, not focused. A
  // tabIndex here would let Tab escape into individual cells and break that
  // pattern.
  return (
    // eslint-disable-next-line jsx-a11y/interactive-supports-focus
    <div
      id={cellId(gridId, { row, col })}
      data-sheet-cell={cellKey({ row, col })}
      role="gridcell"
      aria-colindex={col + 1}
      aria-selected={isActive || inRange}
      aria-label={
        isTitle
          ? `${item.title || 'Untitled'}, opens the item`
          : `${column.label} for ${item.title || 'Untitled'}${shown.length > 0 ? `, ${shown}` : ''}`
      }
      title={
        // A cell cut to its first line offers the whole text on hover.
        shown.endsWith(' …') ? cellText(item, column) : shown.length > 0 ? shown : undefined
      }
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'absolute overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-divider px-2 py-1.5 text-sm',
        column.type === 'number' ? 'text-right' : 'text-left',
        isTitle ? 'font-semibold' : '',
        inRange ? gridRangeCell : '',
        isActive ? 'outline-2 -outline-offset-2 outline-accent' : '',
      )}
      style={cellStyle}
    >
      {column.type === 'checkbox' || column.type === 'completion' ? (
        <Icon icon={item.properties[column.key] === true ? Check : Square} size="sm" />
      ) : column.type === 'select' ||
        column.type === 'priority' ||
        column.type === 'assignee' ||
        column.type === 'multi_select' ? (
        <span className="flex items-center justify-between gap-1">
          <span className="truncate">{shown}</span>
          <Icon icon={ChevronDown} size="sm" />
        </span>
      ) : (
        shown
      )}
    </div>
  );
}
