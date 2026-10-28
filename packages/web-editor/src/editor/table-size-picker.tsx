import { Text } from '@nix/ui';
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

/**
 * The table size picker: sweep a grid to say how many rows and columns, the way Word does.
 *
 * A fixed three-by-three was what "Insert table" used to mean, and every other size was that
 * plus a run of "Add column" and "Add row". The grid asks the question once. It is a grid of
 * buttons rather than two number fields because the answer is a shape, and a shape is easier to
 * point at than to spell; the fields' virtue - keyboard entry - is kept by giving the grid a
 * roving focus that the arrows move, with the size read out as it changes.
 */

export interface TableSize {
  readonly rows: number;
  readonly cols: number;
}

export const MAX_PICKER_ROWS = 8;
export const MAX_PICKER_COLUMNS = 10;

/** Where the cursor starts: the size the old fixed insert produced, so nothing got worse. */
const DEFAULT_SIZE: TableSize = { rows: 3, cols: 3 };

function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(1, value));
}

export function TableSizePicker({
  onPick,
  onDismiss,
}: {
  readonly onPick: (size: TableSize) => void;
  /** Escape, or focus leaving the picker. */
  readonly onDismiss: () => void;
}): ReactNode {
  const [cursor, setCursor] = useState<TableSize>(DEFAULT_SIZE);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const container = useRef<HTMLDivElement | null>(null);

  // Opened, the picker takes the focus: it is a menu, and a menu that opens beside the focus
  // is one a keyboard user has to hunt for.
  useEffect(() => {
    buttons.current.get(`${String(DEFAULT_SIZE.rows)}-${String(DEFAULT_SIZE.cols)}`)?.focus();
  }, []);

  function moveTo(next: TableSize): void {
    setCursor(next);
    buttons.current.get(`${String(next.rows)}-${String(next.cols)}`)?.focus();
  }

  // On the buttons rather than on the group: the group is not itself interactive, and a key
  // handler on it is a handler on nothing a keyboard can reach.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      return;
    }
    const step: Partial<TableSize> | null =
      event.key === 'ArrowRight'
        ? { cols: cursor.cols + 1 }
        : event.key === 'ArrowLeft'
          ? { cols: cursor.cols - 1 }
          : event.key === 'ArrowDown'
            ? { rows: cursor.rows + 1 }
            : event.key === 'ArrowUp'
              ? { rows: cursor.rows - 1 }
              : null;
    if (step === null) {
      return;
    }
    event.preventDefault();
    moveTo({
      rows: clamp(step.rows ?? cursor.rows, MAX_PICKER_ROWS),
      cols: clamp(step.cols ?? cursor.cols, MAX_PICKER_COLUMNS),
    });
  }

  /** Focus leaving the picker altogether dismisses it; moving between its squares does not. */
  function onBlur(event: FocusEvent<HTMLButtonElement>): void {
    const destination = event.relatedTarget;
    if (destination instanceof Node && container.current?.contains(destination) === true) {
      return;
    }
    onDismiss();
  }

  const rows = Array.from({ length: MAX_PICKER_ROWS }, (_, index) => index + 1);
  const cols = Array.from({ length: MAX_PICKER_COLUMNS }, (_, index) => index + 1);

  return (
    <div
      ref={container}
      role="group"
      aria-label="Table size"
      className="flex w-max flex-col gap-2 rounded-md border border-divider bg-background p-3 shadow-md"
    >
      <div className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <div key={row} className="flex gap-0.5">
            {cols.map((col) => {
              const within = row <= cursor.rows && col <= cursor.cols;
              return (
                <button
                  key={col}
                  ref={(element) => {
                    const key = `${String(row)}-${String(col)}`;
                    if (element === null) {
                      buttons.current.delete(key);
                    } else {
                      buttons.current.set(key, element);
                    }
                  }}
                  type="button"
                  aria-label={`${String(row)} by ${String(col)} table`}
                  tabIndex={row === cursor.rows && col === cursor.cols ? 0 : -1}
                  onMouseEnter={() => {
                    setCursor({ rows: row, cols: col });
                  }}
                  onFocus={() => {
                    setCursor({ rows: row, cols: col });
                  }}
                  onClick={() => {
                    onPick({ rows: row, cols: col });
                  }}
                  onKeyDown={onKeyDown}
                  onBlur={onBlur}
                  className={[
                    'size-5 rounded-sm border',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                    within ? 'border-accent-500 bg-accent/25' : 'border-divider bg-surface',
                  ].join(' ')}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* Read out as the cursor moves, so the size is known without counting squares. */}
      <Text variant="caption" tone="muted" as="p" aria-live="polite" aria-atomic="true">
        {String(cursor.rows)} rows × {String(cursor.cols)} columns
      </Text>
    </div>
  );
}
