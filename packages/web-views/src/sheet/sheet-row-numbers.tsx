import { type CSSProperties, type ReactNode } from 'react';

/** Row numbers, pinned horizontally, following vertical scroll. */
export function SheetRowNumbers({
  visibleRows,
  rowHeight,
  style,
}: {
  readonly visibleRows: readonly number[];
  readonly rowHeight: number;
  /** The strip's height and vertical scroll offset. */
  readonly style: CSSProperties;
}): ReactNode {
  return (
    <div className="absolute bottom-0 left-0 top-8 z-20 w-12 overflow-hidden border-r border-divider bg-surface">
      <div className="relative w-12" style={style}>
        {visibleRows.map((row) => (
          <div
            key={row}
            aria-hidden="true"
            className="absolute left-0 flex w-12 items-center justify-center border-b border-divider text-xs text-muted"
            style={{ top: `${String(row * rowHeight)}px`, height: `${String(rowHeight)}px` }} // design-token-exempt: a row's place is grid geometry computed at runtime
          >
            {row + 1}
          </div>
        ))}
      </div>
    </div>
  );
}
