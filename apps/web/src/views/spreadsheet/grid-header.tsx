import { Icon, cn, focusRing, focusRingInset } from '@nix/ui';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { Fragment, useRef, type CSSProperties, type ReactNode } from 'react';

import {
  COLUMN_WIDTH,
  clampWidth,
  resetColumnWidth,
  setColumnWidth,
} from '../../collections/core/column-widths';
import { type SortDirection } from '../../collections/core/view-state';
import { type SpreadsheetColumn } from './grid-model';

interface GridHeaderProps {
  readonly columns: readonly SpreadsheetColumn[];
  readonly visibleCols: readonly number[];
  readonly offsets: readonly number[];
  readonly widths: readonly number[];
  readonly headerStripStyle: CSSProperties;
  readonly sortBy: string | null;
  readonly direction: SortDirection;
  readonly onSort: (key: string, direction: SortDirection) => void;
  readonly viewId: string;
  readonly rowHeight: number;
}

export function GridHeader(props: GridHeaderProps): ReactNode {
  const {
    columns,
    visibleCols,
    offsets,
    widths,
    headerStripStyle,
    sortBy,
    direction,
    onSort,
    viewId,
    rowHeight,
  } = props;
  const resizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  // The header: sort controls, pinned above the scroller and following its horizontal
  // scroll. Outside the grid role on purpose - the body grid's own precedent - so each
  // header is an ordinary focusable button rather than a cell the activedescendant pattern
  // cannot reach. That placement is also why the sorted state is named in the label rather
  // than as aria-sort: there is no columnheader role here for aria-sort to sit on.

  return (
    <div className="overflow-hidden border-b border-divider bg-surface">
      <div className="relative" style={headerStripStyle}>
        {visibleCols.map((col) => {
          const column = columns[col];
          if (column === undefined) {
            return null;
          }
          const sorted = sortBy === column.key;
          // design-token-exempt: a column's place and width are grid geometry computed at runtime
          const style = {
            left: `${String(offsets[col] ?? 0)}px`,
            width: `${String(widths[col] ?? 0)}px`,
            height: `${String(rowHeight)}px`,
          };
          const width = widths[col] ?? 0;
          // design-token-exempt: the handle sits on the column's right edge, grid geometry
          const handleStyle = { left: `${String((offsets[col] ?? 0) + width)}px` };
          return (
            <Fragment key={column.key}>
              <button
                type="button"
                aria-label={`Sort by ${column.label}${sorted ? `, currently ${direction}` : ''}`}
                onClick={() => {
                  onSort(
                    column.key,
                    sorted && direction === 'ascending' ? 'descending' : 'ascending',
                  );
                }}
                className={cn(
                  'absolute top-0 flex cursor-default items-center gap-1 truncate border-r border-divider px-2 text-left text-sm font-semibold',
                  sorted ? 'text-accent-text' : 'text-foreground',
                  focusRing,
                )}
                style={style}
              >
                {column.label}
                {/* The neutral glyph on unsorted columns is what says "this sorts" to a sighted
                  visitor - Table.tsx's own convention, kept in step. */}
                <span className={sorted ? '' : 'text-muted'}>
                  <Icon
                    icon={
                      sorted ? (direction === 'ascending' ? ArrowUp : ArrowDown) : ChevronsUpDown
                    }
                    size="sm"
                  />
                </span>
              </button>
              {/* A focusable window-splitter on the column's edge (requirement 2): drag it, or
                focus it and use the arrows; Home forgets the dragged width. The drag never
                reaches the sort button behind it. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ARIA's focusable separator with aria-valuenow is the window-splitter widget; jsx-a11y models separator only as a static divider. */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize column ${column.label}`}
                aria-valuenow={width}
                aria-valuemin={COLUMN_WIDTH.min}
                aria-valuemax={COLUMN_WIDTH.max}
                aria-valuetext={`${String(width)} pixels`}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a window-splitter separator is focusable by its ARIA definition
                tabIndex={0}
                className={cn(
                  'absolute top-0 z-10 h-full w-3 -translate-x-1/2 any-pointer-coarse:w-(--control-lg) cursor-col-resize touch-none',
                  focusRingInset,
                )}
                style={handleStyle}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  resizeDrag.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startWidth: width,
                  };
                }}
                onPointerMove={(event) => {
                  const drag = resizeDrag.current;
                  if (drag?.pointerId !== event.pointerId) return;
                  setColumnWidth(
                    viewId,
                    column.key,
                    clampWidth(drag.startWidth + event.clientX - drag.startX),
                  );
                }}
                onPointerUp={() => {
                  resizeDrag.current = null;
                }}
                onPointerCancel={() => {
                  resizeDrag.current = null;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    setColumnWidth(viewId, column.key, clampWidth(width - COLUMN_WIDTH.step));
                  } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setColumnWidth(viewId, column.key, clampWidth(width + COLUMN_WIDTH.step));
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    resetColumnWidth(viewId, column.key);
                  } else if (event.key === 'Escape' && resizeDrag.current !== null) {
                    event.preventDefault();
                    setColumnWidth(viewId, column.key, resizeDrag.current.startWidth);
                    resizeDrag.current = null;
                  }
                }}
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-divider"
                />
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
