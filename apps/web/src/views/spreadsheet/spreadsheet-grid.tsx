import { type CellRef, parseCellKey, rangeContains } from '@nix/sheet';
import { ContextMenu, Text, cn, focusRingInset } from '@nix/ui';
import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

import { FILL_SERIES_SHORTCUT } from '../../keyboard/shortcut-registry';
import { formatShortcut } from '../../lib/shortcuts';
import { type Item, type PropertyDefinition } from '../core/container-model';
import type { PlanOutcome, PlanWrite } from '../core/use-container';
import { type SortDirection } from '../core/view-state';
import { CellEditor } from '../sheet/cell-editor';
import {
  INITIAL_SELECTION,
  clamp,
  selectedRange,
  selectionReducer,
  type GridBounds,
} from '../sheet/selection';
import { FillSeriesOffer } from './fill-series-offer';
import { gridCellMenuItems } from './grid-cell-menu';
import { gridClipboardHandlers } from './grid-clipboard';
import { GridCell } from './grid-cell';
import { SCROLLER_HEIGHT_CLASS, cellId, pickRowHeight } from './grid-geometry';
import { GridHeader } from './grid-header';
import { TITLE_COLUMN_KEY } from '../core/columns';
import { cellText, type SpreadsheetColumn } from './grid-model';
import { GridPropertyPanel } from './grid-property-panel';
import { GridToolbar } from './grid-toolbar';
import { canEditProperty, useGridEdit, usesPicker } from './use-grid-edit';
import { useGridKeys } from './use-grid-keys';
import { useFillOffer } from './use-fill-offer';
import { useGridViewport } from './use-grid-viewport';
import { useSelectionFollowsItem } from './use-selection-follows-item';

interface SpreadsheetGridProps {
  readonly items: readonly Item[];
  readonly columns: readonly SpreadsheetColumn[];
  readonly properties: readonly PropertyDefinition[];
  readonly sortBy: string | null;
  readonly direction: SortDirection;
  readonly onSort: (key: string, direction: SortDirection) => void;

  /** Writes one cell's edit and answers with the refusal, or null when stored. */
  readonly onWrite: (itemId: string, bag: Record<string, unknown>) => Promise<string | null>;

  /** Writes one gesture's worth of rows - paste, fill, clear - and answers for all of them. */
  readonly onWriteMany: (writes: readonly PlanWrite[]) => Promise<PlanOutcome>;

  readonly onOpen: (itemId: string) => void;

  /** The view whose dragged column widths are kept per device (column-widths.ts). */
  readonly viewId: string;
}

export function SpreadsheetGrid(props: SpreadsheetGridProps): ReactNode {
  const {
    items,
    columns,
    properties,
    sortBy,
    direction,
    onSort,
    onWrite,
    onWriteMany,
    onOpen,
    viewId,
  } = props;

  const [selection, dispatch] = useReducer(selectionReducer, INITIAL_SELECTION);

  // Fixed for this mount: a window moved between a mouse and a touch screen re-opens the view.
  const [rowHeight] = useState(pickRowHeight);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const menuCellRef = useRef<CellRef | null>(null);

  const bounds: GridBounds = { rows: items.length, cols: columns.length };
  const active = clamp(selection.active, bounds);
  const {
    notice,
    setNotice,
    propertyEdit,
    propertyRefusal,
    propertyPanelRef,
    editedItem,
    editedProperty,
    closePropertyEdit,
    commitProperty,
    applyPlan,
    commitDraft,
    cancelEdit,
    beginEdit,
  } = useGridEdit({
    items,
    columns,
    properties,
    selection,
    dispatch,
    bounds,
    active,
    scrollerRef,
    onWrite,
    onWriteMany,
    onOpen,
  });
  const activeColumn = columns[active.col];
  const activeItem = items[active.row];
  const activeProperty = properties.find((property) => property.key === activeColumn?.key);

  useSelectionFollowsItem({
    items,
    active,
    bounds,
    navigating: selection.mode === 'nav',
    dispatch,
    setNotice,
  });

  const {
    scroll,
    setScroll,
    viewport,
    widths,
    offsets,
    totalWidth,
    totalHeight,
    visibleRows,
    visibleCols,
    activeTop,
    activeLeft,
    activeWidth,
  } = useGridViewport({ viewId, columns, rowCount: items.length, rowHeight, active, scrollerRef });

  const range = selectedRange(selection);
  const rangeIsCell = range.startRow === range.endRow && range.startCol === range.endCol;

  const { fillOffer, patternedColumn, dismiss } = useFillOffer(
    range,
    selection.mode === 'nav',
    items,
    columns,
  );

  const { onGridKeyDown, fillSeries } = useGridKeys({
    items,
    columns,
    selection,
    dispatch,
    bounds,
    active,
    range,
    viewportHeight: viewport.height,
    rowHeight,
    applyPlan,
    beginEdit,
    setNotice,
  });

  const clipboard = gridClipboardHandlers(
    items,
    columns,
    range,
    selection.mode === 'edit',
    setNotice,
    applyPlan,
  );

  const gridId = useId();
  const hintId = `${gridId}-hint`;

  // The editor overlay takes focus when an edit begins; focus returns to the scroller on commit.
  useEffect(() => {
    if (selection.mode === 'edit') {
      editorRef.current?.focus();
      editorRef.current?.select();
    }
  }, [selection.mode]);

  function captureMenuCell(target: EventTarget | null): void {
    menuCellRef.current =
      target instanceof Element
        ? parseCellKey(target.closest('[data-sheet-cell]')?.getAttribute('data-sheet-cell') ?? '')
        : null;
  }

  /**
   * Mouse down rather than click so a shift-click extends the range from the pressed corner (there
   * is no drag-selection; Shift with the arrows or a shift-click is the range gesture).
   *
   * Whether the grid already held focus, checked before we take it below, is what tells a tap that
   * lands on the already-active cell apart from the tap that first brought that cell to life: the
   * former is a person asking to edit or open what they can already see is selected, the latter is
   * the ordinary first touch that only selects. Without this, a touch or mouse user could select a
   * cell but never edit or open one without a double-click or the keyboard.
   */
  function pressCell(
    event: ReactMouseEvent<HTMLDivElement>,
    item: Item,
    column: SpreadsheetColumn,
    row: number,
    col: number,
  ): void {
    if (event.button !== 0) return;
    const isActive = row === active.row && col === active.col;
    const isTitle = column.key === TITLE_COLUMN_KEY;
    const alreadyFocused =
      scrollerRef.current !== null && document.activeElement === scrollerRef.current;
    event.preventDefault();
    scrollerRef.current?.focus({ preventScroll: true });
    // A draft that fails coercion keeps its editor open: moving the selection
    // out from under it would throw away the typed text with the notice still
    // claiming it can be corrected.
    if (selection.mode === 'edit' && !commitDraft('stay')) {
      return;
    }
    if (alreadyFocused && isActive && !event.shiftKey) {
      if (isTitle) {
        onOpen(item.id);
      } else {
        beginEdit('open', cellText(item, column));
      }
      return;
    }
    dispatch({ type: 'moveTo', ref: { row, col }, extend: event.shiftKey });
    const property = properties.find((entry) => entry.key === column.key);
    if (!event.shiftKey && canEditProperty(property) && usesPicker(property)) {
      beginEdit('open', cellText(item, column), { row, col });
    }
  }

  function openCell(item: Item, column: SpreadsheetColumn): void {
    if (column.key === TITLE_COLUMN_KEY) {
      onOpen(item.id);
    } else {
      beginEdit('open', cellText(item, column));
    }
  }

  // design-token-exempt: the editor overlay, header strip and scrollable canvas sit at grid
  // geometry computed at runtime.
  const editorStyle = {
    top: `${String(activeTop)}px`,
    left: `${String(activeLeft)}px`,
    width: `${String(activeWidth)}px`,
    height: `${String(rowHeight)}px`,
  };
  const headerStripStyle = {
    width: `${String(totalWidth)}px`,
    height: `${String(rowHeight)}px`,
    transform: `translateX(-${String(scroll.left)}px)`,
  };
  const canvasStyle = { width: `${String(totalWidth)}px`, height: `${String(totalHeight)}px` };

  return (
    <div className="min-w-0 max-w-full">
      <GridToolbar
        hintId={hintId}
        editing={selection.mode === 'edit'}
        onApply={() => {
          commitDraft('stay');
        }}
        onCancel={cancelEdit}
        activeColumnLabel={activeColumn?.label}
        activeItemTitle={activeItem?.title}
        canEdit={canEditProperty(activeProperty)}
        usesPopover={usesPicker(activeProperty) || propertyEdit !== null}
        popoverOpen={
          propertyEdit !== null && editedItem !== undefined && editedProperty !== undefined
        }
        popoverLabel={`Edit ${editedProperty?.label ?? activeColumn?.label ?? 'property'} for ${(editedItem?.title ?? activeItem?.title ?? '') || 'Untitled'}`}
        onPopoverOpenChange={(open) => {
          if (!open) closePropertyEdit();
          else if (activeColumn !== undefined && activeItem !== undefined) {
            beginEdit('open', cellText(activeItem, activeColumn));
          }
        }}
        popoverContent={({ close }) => (
          <GridPropertyPanel
            panelRef={propertyPanelRef}
            item={editedItem}
            property={editedProperty}
            refusal={propertyRefusal}
            onCommit={commitProperty}
            onEscape={() => {
              closePropertyEdit(false);
              requestAnimationFrame(() => scrollerRef.current?.focus({ preventScroll: true }));
            }}
            onDone={() => {
              close();
              requestAnimationFrame(() => scrollerRef.current?.focus({ preventScroll: true }));
            }}
          />
        )}
        onEdit={() => {
          if (activeColumn !== undefined && activeItem !== undefined)
            beginEdit('open', cellText(activeItem, activeColumn));
        }}
        onOpenActive={() => {
          if (activeItem !== undefined) {
            onOpen(activeItem.id);
          }
        }}
      />

      <GridHeader
        columns={columns}
        visibleCols={visibleCols}
        offsets={offsets}
        widths={widths}
        headerStripStyle={headerStripStyle}
        sortBy={sortBy}
        direction={direction}
        onSort={onSort}
        viewId={viewId}
        rowHeight={rowHeight}
      />

      {/* The body: the one real scroller, and the keyboard's home. */}
      <ContextMenu
        label="Spreadsheet cell actions"
        items={() =>
          gridCellMenuItems(menuCellRef.current ?? active, items, columns, properties, {
            onOpen,
            commitDraft,
            dispatch,
            beginEdit,
            applyPlan,
          })
        }
      >
        {(target) => (
          <div
            {...target}
            ref={scrollerRef}
            role="grid"
            aria-label="Spreadsheet of items"
            aria-describedby={hintId}
            aria-rowcount={bounds.rows}
            aria-colcount={bounds.cols}
            aria-activedescendant={selection.mode === 'edit' ? undefined : cellId(gridId, active)}
            aria-multiselectable="true"
            tabIndex={0}
            onContextMenuCapture={(event) => {
              captureMenuCell(event.target);
            }}
            onPointerDownCapture={(event) => {
              captureMenuCell(event.target);
            }}
            onKeyDownCapture={() => {
              menuCellRef.current = null;
            }}
            onKeyDown={onGridKeyDown}
            onScroll={(event) => {
              // Identity-guarded: scroll events between window boundaries, overscroll bounce and
              // single-axis wheels must not re-render a few hundred cells to change nothing.
              const { scrollTop, scrollLeft } = event.currentTarget;
              setScroll((current) =>
                current.top === scrollTop && current.left === scrollLeft
                  ? current
                  : { top: scrollTop, left: scrollLeft },
              );
            }}
            {...clipboard}
            className={cn(
              'relative min-w-0 max-w-full overflow-auto overscroll-contain outline-none',
              SCROLLER_HEIGHT_CLASS,
              focusRingInset,
            )}
          >
            <div className="relative" role="presentation" style={canvasStyle}>
              {visibleRows.map((row) => {
                const item = items[row];
                if (item === undefined) {
                  return null;
                }
                return (
                  <div key={item.id} role="row" aria-rowindex={row + 1} className="contents">
                    {visibleCols.map((col) => {
                      const column = columns[col];
                      if (column === undefined) {
                        return null;
                      }
                      return (
                        <GridCell
                          key={column.key}
                          gridId={gridId}
                          item={item}
                          column={column}
                          row={row}
                          col={col}
                          rowHeight={rowHeight}
                          left={offsets[col] ?? 0}
                          width={widths[col] ?? 0}
                          isActive={row === active.row && col === active.col}
                          inRange={!rangeIsCell && rangeContains(range, { row, col })}
                          onMouseDown={(event) => {
                            pressCell(event, item, column, row, col);
                          }}
                          onDoubleClick={() => {
                            openCell(item, column);
                          }}
                        />
                      );
                    })}
                  </div>
                );
              })}

              {selection.mode === 'edit' &&
              activeColumn !== undefined &&
              activeItem !== undefined ? (
                <CellEditor
                  ref={editorRef}
                  ariaLabel={`Edit ${activeColumn.label} for ${activeItem.title || 'Untitled'}`}
                  value={selection.draft}
                  onChange={(event) => {
                    dispatch({ type: 'setDraft', draft: event.target.value });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitDraft('down');
                    } else if (event.key === 'Tab') {
                      event.preventDefault();
                      commitDraft('right');
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => {
                    // A genuine click-away commits, as in every spreadsheet. This blur fires
                    // synchronously inside the cell handler's focus() call, BEFORE that handler's own
                    // commitDraft - so this is the call that commits on a click-away, and the settled
                    // flag is what keeps the cell handler's later call from committing twice.
                    if (selection.mode === 'edit') {
                      commitDraft('stay');
                    }
                  }}
                  position={editorStyle}
                  // Chosen from the stored value, so the editor never swaps element mid-edit.
                  multiline={
                    activeColumn.type === 'long_text' ||
                    /[\r\n]/.test(cellText(activeItem, activeColumn))
                  }
                />
              ) : null}
            </div>
          </div>
        )}
      </ContextMenu>

      {fillOffer === null || patternedColumn === null ? null : (
        <FillSeriesOffer
          columnLabel={patternedColumn.column.label}
          describe={patternedColumn.describe}
          preview={patternedColumn.preview}
          rows={fillOffer.rows}
          otherColumns={fillOffer.columns.length - 1}
          shortcut={formatShortcut(FILL_SERIES_SHORTCUT)}
          onFill={() => {
            fillSeries();
            dismiss();
            scrollerRef.current?.focus({ preventScroll: true });
          }}
          onDismiss={() => {
            dismiss();
            scrollerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}

      {/* Always mounted so the announcement fires the moment a sentence appears; the visible
          chrome only draws when there is something to read, so an empty region is not a stray
          rule under the grid. */}
      <Text
        variant="note"
        as="p"
        role="status"
        className={notice === null ? '' : 'border-t border-divider px-3 py-1'}
      >
        {notice}
      </Text>
    </div>
  );
}
