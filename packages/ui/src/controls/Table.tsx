import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

import { cn } from '../lib/cn';
import { ContextMenu, type ContextMenuTargetProps } from './ContextMenu';
import { type MenuEntry } from './Menu';
import { Icon } from '../primitives/Icon';
import { Text } from '../primitives/Text';
import {
  dragHandleLineStates,
  focusRing,
  focusRingInset,
  inkWashStates,
} from '../primitives/interaction';

/**
 * <Table> - rows of data, with the four things a data table owes the reader.
 *
 * A caption saying what the table is, a header row saying what the columns are, an honest account
 * of what is in the body, and - where the data can be reordered - a way to say so that a keyboard
 * and a screen reader can both reach.
 *
 * **Loading and empty are different answers and are drawn differently.** "No documents" and "we
 * have not finished asking" look identical if a loading table renders an empty body, and the first
 * one is a statement of fact the reader will act on. So `loading` wins over the row count: while it
 * is set the table says it is working and marks itself `aria-busy`, and the caller's empty message
 * is only ever shown when the answer has arrived and the answer was none.
 *
 * **Sorting is controlled.** The sort lives in the URL in this application - it has to, or a sorted
 * table cannot be linked, bookmarked or restored by the back button - so the component renders the
 * sort it is given and reports the sort a click asked for. It never holds one. What it does own is
 * the *policy*: clicking the sorted column reverses it, clicking any other column starts it
 * ascending. That is a pure function of the current sort, so it belongs with the header that
 * triggers it rather than being retyped at every call site.
 *
 * The directions are ARIA's own words (`ascending`/`descending`) rather than `asc`/`desc`, so the
 * value that goes into `aria-sort` is the value the caller holds - no mapping table, and nothing to
 * get backwards.
 */

type TableSortDirection = 'ascending' | 'descending';

export interface TableSort {
  /** The `key` of the sorted column. */
  readonly columnKey: string;
  readonly direction: TableSortDirection;
}

export interface TableColumn<Row> {
  /** Identifies the column in `sort` and as a React key. Stable across renders and reorders. */
  readonly key: string;

  /** The header's visible text. Also what a sortable header's button is named. */
  readonly header: string;

  /** Draws one cell. A function rather than a field name so a cell can be a `<Tag>` or a link. */
  readonly cell: (row: Row) => ReactNode;

  /**
   * Offers this column's header as a sort control. Ignored without `onSortChange`: a header that
   * looks clickable and does nothing is worse than a header that never offered.
   */
  readonly sortable?: boolean;

  /**
   * Renders this column's cell as `<th scope="row">` rather than `<td>`, so a screen reader
   * announces which row a cell belongs to as it moves across. At most one column should claim it -
   * the one a person would use to name the row.
   */
  readonly rowHeader?: boolean;

  /** Numbers read right-aligned; everything else reads left-aligned. */
  readonly align?: 'start' | 'end';

  /**
   * A narrow leading gutter (a selection box, say): the header is read by assistive technology but
   * not drawn, and the column takes no more width than its cell needs.
   */
  readonly gutter?: boolean;
}

export interface TableProps<Row> {
  /**
   * What this table is, as a sentence. Rendered as a real `<caption>`: it is the table's accessible
   * name, and a heading sitting above the table is not - assistive technology announcing "table,
   * 4 columns, 30 rows" with no name leaves the reader to guess which table they landed in.
   */
  readonly caption: string;

  /** Keep the caption as the accessible name but do not draw it: a heading already sits above. */
  readonly captionHidden?: boolean;

  readonly columns: readonly TableColumn<Row>[];

  readonly rows: readonly Row[];

  /** A stable identity per row. Row order changes under sorting, so an index would not do. */
  readonly rowKey: (row: Row) => string;

  /** Shown in place of rows when the data has arrived and there is none of it. */
  readonly emptyMessage: string;

  /** True while the rows are still being fetched. Suppresses `emptyMessage`. */
  readonly loading?: boolean;

  /** What the table says while `loading`. Overridable because only the caller knows for what. */
  readonly loadingMessage?: string;

  /** The sort currently applied to `rows`. Absent means the caller's own order. */
  readonly sort?: TableSort;

  /** Reports the sort a header click asked for. Its absence makes every column unsortable. */
  readonly onSortChange?: (sort: TableSort) => void;

  /** Layout only - margin, width, grid placement. Never a restyle of the table. */
  readonly className?: string;

  /**
   * The actions a secondary click on a row offers, built when the menu opens. Omit, or return no
   * entries, to leave the browser's own menu in place.
   */
  readonly rowContextMenu?: (row: Row) => readonly MenuEntry[];
  /** What a row's menu is called - which row it acts on. Defaults to "Row actions". */
  readonly rowContextMenuLabel?: (row: Row) => string;
  /** Offers a touch long-press on a row to the caller first; see `ContextMenu`'s `onLongPress`. */
  readonly rowLongPress?: (row: Row) => boolean;
  /** Marks a row selected: a tint and `aria-selected`. Colour is never the only signal. */
  readonly rowSelected?: (row: Row) => boolean;
  /**
   * Drag-and-drop on a row, for a caller that lets rows be dragged onto each other. `dropTarget`
   * outlines the row a drop would land on; the handlers are the browser's own.
   */
  readonly rowDrag?: (row: Row) => TableRowDrag;

  /** Sparse row geometry when the caller renders only a measured window of a larger table. */
  readonly virtualization?: {
    readonly totalRows: number;
    readonly rowIndexes: readonly number[];
    readonly spacerHeights: readonly number[];
  };

  /** The semantic table element, used by pane-aware virtualizers as their measured root. */
  readonly tableRef?: Ref<HTMLTableElement>;

  /** Pixel widths per column key; a column without one keeps the browser's own layout. */
  readonly columnWidths?: Readonly<Record<string, number>>;

  /**
   * Offers a resize handle on every header. Called with the clamped width as a drag or an arrow
   * key moves it; `onColumnWidthReset` answers the handle's Home key. Absent, no handle is drawn.
   */
  readonly onColumnResize?: (columnKey: string, width: number) => void;
  readonly onColumnWidthReset?: (columnKey: string) => void;
}

/** The widths a header handle may reach, and how far one arrow keypress moves it. */
const TABLE_COLUMN_WIDTH = { min: 64, max: 800, step: 16 } as const;

function clampTableWidth(width: number): number {
  return Math.min(TABLE_COLUMN_WIDTH.max, Math.max(TABLE_COLUMN_WIDTH.min, Math.round(width)));
}

const cellPadding = 'px-3 py-2';

const headerText = 'font-heading text-xs tracking-wider uppercase';

/**
 * The sort button fills its header cell rather than sitting inside it, so the whole header is the
 * target. It is a plain `<button>` and not a `<Button>` because none of the four button shapes is a
 * table header - `ghost` would put accent text on every sortable column and make the header row
 * compete with the primary action - but the interaction constants are the shared ones, so hover,
 * press and focus read the same here as everywhere else.
 */
const sortButton = cn(
  'flex w-full cursor-default items-center gap-1 rounded-sm text-left transition-colors',
  headerText,
  cellPadding,
  focusRing,
  inkWashStates,
);

const SORT_GLYPH = { ascending: ArrowUp, descending: ArrowDown } as const;

/**
 * The next sort a click on `columnKey` is asking for: reverse the column that is already sorted,
 * start any other column ascending.
 */
function nextSort(columnKey: string, current: TableSort | undefined): TableSort {
  if (current?.columnKey === columnKey) {
    return {
      columnKey,
      direction: current.direction === 'ascending' ? 'descending' : 'ascending',
    };
  }

  return { columnKey, direction: 'ascending' };
}

export interface TableRowDrag extends Pick<
  HTMLAttributes<HTMLTableRowElement>,
  'draggable' | 'onDragStart' | 'onDragOver' | 'onDragLeave' | 'onDragEnd' | 'onDrop'
> {
  readonly dropTarget?: boolean;
}

export function Table<Row>(props: TableProps<Row>): ReactNode {
  const {
    caption,
    captionHidden,
    columns,
    rows,
    rowKey,
    emptyMessage,
    loading = false,
    loadingMessage = 'Loading',
    sort,
    onSortChange,
    className,
    virtualization,
    rowContextMenu,
    rowContextMenuLabel,
    rowLongPress,
    rowSelected,
    rowDrag,
    tableRef,
    columnWidths,
    onColumnResize,
    onColumnWidthReset,
  } = props;

  // One row, with the context-menu marker when the caller offers row actions. A plain row when it
  // does not, so a table without a menu pays nothing for one.
  const drawRow = (
    row: Row,
    dataIndex: number,
    contextTarget?: ContextMenuTargetProps,
  ): ReactNode => {
    const { dropTarget = false, ...dragProps } = rowDrag?.(row) ?? {};
    return (
      <tr
        key={rowKey(row)}
        {...contextTarget}
        {...dragProps}
        // `group` lets a cell reveal something on row hover or focus (the list's selection box).
        className={cn(
          'group',
          rowSelected?.(row) === true && 'bg-accent/10',
          dropTarget && 'outline-2 -outline-offset-2 outline-accent',
        )}
        aria-selected={rowSelected === undefined ? undefined : rowSelected(row)}
        aria-rowindex={virtualization === undefined ? undefined : dataIndex + 2}
        data-virtual-index={virtualization === undefined ? undefined : dataIndex}
      >
        {columns.map((column) => {
          const cellClass = cn(
            'border-b border-divider font-body text-md text-foreground',
            cellPadding,
            column.gutter === true && 'w-px pr-0',
            column.align === 'end' ? 'text-right tabular-nums' : 'text-left',
          );

          return column.rowHeader === true ? (
            <th key={column.key} scope="row" className={cn(cellClass, 'font-medium')}>
              {column.cell(row)}
            </th>
          ) : (
            <td key={column.key} className={cellClass}>
              {column.cell(row)}
            </td>
          );
        })}
      </tr>
    );
  };

  const message = loading ? loadingMessage : rows.length === 0 ? emptyMessage : null;

  return (
    // `border-separate` with no spacing rather than `border-collapse`: collapsed borders merge the
    // header's hairline into the first row's, which on a 1px divider means one of the two rules
    // silently disappears.
    <table
      ref={tableRef}
      aria-busy={loading || undefined}
      aria-rowcount={virtualization === undefined ? undefined : virtualization.totalRows + 1}
      className={cn('w-full border-separate border-spacing-0 text-left', className)}
    >
      <Text
        as="caption"
        variant="h6"
        tone="muted"
        className={cn('pb-2 text-left', captionHidden === true && 'sr-only')}
      >
        {caption}
      </Text>

      <thead>
        <tr>
          {columns.map((column) => {
            const sortable = column.sortable === true && onSortChange !== undefined;
            const sorted = sort?.columnKey === column.key ? sort.direction : undefined;
            const alignEnd = column.align === 'end';

            const width = columnWidths?.[column.key];
            return (
              <th
                key={column.key}
                scope="col"
                // Omitted rather than "none" on a column that cannot be sorted at all: `aria-sort`
                // means "this column participates in sorting", and claiming it everywhere would
                // have a screen reader offer a sort that does not exist.
                aria-sort={sortable ? (sorted ?? 'none') : undefined}
                className={cn(
                  'border-b border-divider text-foreground/70',
                  headerText,
                  sortable ? 'p-0' : cellPadding,
                  column.gutter === true && 'w-px pr-0',
                  alignEnd ? 'text-right' : 'text-left',
                  onColumnResize === undefined ? '' : 'relative',
                )}
                // design-token-exempt: a dragged column width is runtime geometry, not a design value
                style={
                  width === undefined
                    ? undefined
                    : { width: `${String(width)}px`, minWidth: `${String(width)}px` }
                }
              >
                {sortable ? (
                  <button
                    type="button"
                    onClick={() => {
                      onSortChange(nextSort(column.key, sort));
                    }}
                    className={cn(sortButton, alignEnd ? 'justify-end' : 'justify-start')}
                  >
                    {column.header}
                    {/* Decorative: `aria-sort` on the header already carries the state, and a named
                        glyph would make the button announce its direction twice. The unsorted
                        chevron pair is what tells a sighted reader the column can be sorted. */}
                    <Icon
                      icon={sorted === undefined ? ChevronsUpDown : SORT_GLYPH[sorted]}
                      size="sm"
                    />
                  </button>
                ) : column.gutter === true ? (
                  <span className="sr-only">{column.header}</span>
                ) : (
                  column.header
                )}
                {onColumnResize === undefined ? null : (
                  <ColumnResizeHandle
                    label={column.header}
                    width={width}
                    onResize={(next) => {
                      onColumnResize(column.key, next);
                    }}
                    onReset={
                      onColumnWidthReset === undefined
                        ? undefined
                        : () => {
                            onColumnWidthReset(column.key);
                          }
                    }
                  />
                )}
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {message === null ? (
          rows.flatMap((row, rowOffset) => {
            const dataIndex = virtualization?.rowIndexes[rowOffset] ?? rowOffset;
            const before = virtualization?.spacerHeights[rowOffset] ?? 0;
            return [
              before > 0 ? (
                <tr key={`spacer-before-${String(dataIndex)}`} aria-hidden="true">
                  <td
                    colSpan={columns.length}
                    className="border-0 p-0"
                    style={{ height: before }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
              rowContextMenu === undefined ? (
                drawRow(row, dataIndex)
              ) : (
                <ContextMenu
                  key={rowKey(row)}
                  label={rowContextMenuLabel?.(row) ?? 'Row actions'}
                  items={() => rowContextMenu(row)}
                  {...(rowLongPress === undefined ? {} : { onLongPress: () => rowLongPress(row) })}
                >
                  {(contextTarget) => drawRow(row, dataIndex, contextTarget)}
                </ContextMenu>
              ),
              rowOffset === rows.length - 1 &&
              (virtualization?.spacerHeights[rows.length] ?? 0) > 0 ? (
                <tr key="spacer-after" aria-hidden="true">
                  <td
                    colSpan={columns.length}
                    className="border-0 p-0"
                    style={{ height: virtualization?.spacerHeights[rows.length] }} // design-token-exempt: the spacer height is measured runtime geometry from the shared virtual window, not a design value
                  />
                </tr>
              ) : null,
            ];
          })
        ) : (
          <tr>
            {/* One cell across the table rather than an empty body: a table with a header and no
                rows renders as a bare rule, which reads as a rendering fault rather than an
                answer. */}
            <td
              colSpan={columns.length}
              className={cn('border-b border-divider text-center', cellPadding)}
            >
              <Text variant="bodySmall" tone="muted">
                {message}
              </Text>
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/**
 * A window-splitter separator on a header's right edge: drag it, or focus it and use the arrow
 * keys, so a resize is never a pointer-only act. Pointer capture keeps the drag on the handle, and
 * the width is committed as it moves so the table follows the pointer; Escape puts the start back.
 */
function ColumnResizeHandle({
  label,
  width,
  onResize,
  onReset,
}: {
  readonly label: string;
  readonly width: number | undefined;
  readonly onResize: (width: number) => void;
  readonly onReset: (() => void) | undefined;
}): ReactNode {
  const handle = useRef<HTMLDivElement>(null);
  const [automaticWidth, setAutomaticWidth] = useState<number>(TABLE_COLUMN_WIDTH.min);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  useLayoutEffect(() => {
    const column = handle.current?.parentElement;
    if (width !== undefined || column === undefined || column === null) return;
    const update = () => {
      setAutomaticWidth(Math.round(column.getBoundingClientRect().width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    return () => {
      observer.disconnect();
    };
  }, [width]);
  const currentWidth = width ?? automaticWidth;
  const measured = (element: HTMLElement): number =>
    width ?? element.parentElement?.getBoundingClientRect().width ?? TABLE_COLUMN_WIDTH.min;
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ARIA's focusable separator with aria-valuenow is the window-splitter widget; jsx-a11y models separator only as a static divider.
    <div
      ref={handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize column ${label}`}
      aria-valuenow={currentWidth}
      aria-valuemin={Math.min(TABLE_COLUMN_WIDTH.min, currentWidth)}
      aria-valuemax={Math.max(TABLE_COLUMN_WIDTH.max, currentWidth)}
      aria-valuetext={width === undefined ? 'automatic width' : `${String(width)} pixels`}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a window-splitter separator is focusable by its ARIA definition
      tabIndex={0}
      className={cn(
        'group absolute inset-y-0 right-0 z-10 w-3 translate-x-1/2 cursor-col-resize touch-none',
        focusRingInset,
      )}
      onPointerDown={(event) => {
        // The header behind this is a sort button; a drag must not also sort.
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: measured(event.currentTarget),
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current?.pointerId !== event.pointerId) return;
        onResize(clampTableWidth(current.startWidth + event.clientX - current.startX));
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        const current = measured(event.currentTarget);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault();
          onResize(clampTableWidth(current - TABLE_COLUMN_WIDTH.step));
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault();
          onResize(clampTableWidth(current + TABLE_COLUMN_WIDTH.step));
        } else if (event.key === 'Home' && onReset !== undefined) {
          event.preventDefault();
          onReset();
        } else if (event.key === 'Escape' && drag.current !== null) {
          event.preventDefault();
          onResize(drag.current.startWidth);
          drag.current = null;
        }
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
          dragHandleLineStates,
        )}
      />
    </div>
  );
}
