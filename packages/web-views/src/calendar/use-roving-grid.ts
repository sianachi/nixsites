import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

/**
 * One tab stop for a whole grid of repeated controls, with the arrow keys moving between them.
 *
 * The hour grid renders one create control per hour per day - 168 of them on a week - and every
 * one used to be its own tab stop. Getting *past* an empty week by keyboard meant 168 presses, so
 * the affordance built for keyboard users was the thing making the grid unusable by keyboard. The
 * APG's answer for a grid of like controls is a roving tabindex: one cell carries `tabindex="0"`,
 * every other cell carries `-1`, Tab enters and leaves the grid in one press, and the arrow keys
 * move which cell is the entry point.
 *
 * The key model follows `Listbox`'s (packages/ui/src/patterns/Listbox.tsx) in mechanics - a
 * controlled active position, clamped on the way out rather than corrected in an effect - but not
 * in shape: a listbox moves `aria-activedescendant` while focus stays in a field, and here focus
 * really moves, because each slot is a genuine button that opens into its own text field. No ARIA
 * is added: these are buttons, they announce as buttons, and claiming `role="grid"` would owe
 * column/row header semantics the hour grid's flex layout does not have.
 *
 * **The tabindex is written to the DOM rather than passed as a prop.** The control in each slot is
 * `CreateItemControl`, whose contract is deliberately "a button and a field, and nothing else" -
 * it exposes no tabindex, and growing one for a single caller would put a grid's concern on a
 * control the list and the board also use. Which slot is the entry point is a fact about the grid,
 * so the grid's hook owns it, the way the APG's own grid examples manage `tabindex` from the
 * container. React never contests the attribute because the control never sets it.
 *
 * **The keys are the APG's, including Home and End.** Up and Down move a row, Left and Right move a
 * column, Home and End move to the first and last cell *of the row*, and Ctrl (or Cmd) with either
 * jumps to the grid's first or last cell. Nothing wraps: the edges of the grid are meant to be
 * findable by feel. Home and End moving the row instead - the hour grid's first mapping, midnight
 * and 23:00 in the same day - read naturally for hours and disagreed with every other grid on the
 * platform, which is not a difference a person can be told about mid-task.
 *
 * **The caller's contract: each slot contains exactly one button.** The slots are marked with
 * `data-roving-row` / `data-roving-column`, and the hook takes the first button inside each one as
 * the thing to make tabbable. A slot that grew a second control - a delete beside the create, say -
 * would silently keep the tabindex on the first and hand the rest of them back the browser default,
 * which is the 168-tab-stop bug returning with nothing to show for it. A slot needing two controls
 * needs this hook to be told which one is the entry point, not a second `querySelector`.
 */

export interface RovingGrid {
  /** Goes on the element containing every slot. */
  readonly containerRef: RefObject<HTMLDivElement | null>;

  /** The arrow keys, Home and End, for the same container. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;

  /**
   * Keeps the active cell in step with where focus really is, for the same container.
   *
   * A pointer click focuses a slot the arrow keys never chose; without this, the next Tab out and
   * back would land somewhere other than where the person just was.
   */
  readonly onFocusCapture: (event: FocusEvent<HTMLElement>) => void;
}

export function useRovingGrid(rows: number, columns: number): RovingGrid {
  const containerRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState({ row: 0, column: 0 });

  // Clamped on the way out rather than corrected in an effect, following `useListbox`: switching
  // the calendar from week to day shrinks the columns from seven to one, and an effect that reset
  // the position would leave one render pointing past the end.
  const row = Math.min(active.row, Math.max(rows - 1, 0));
  const column = Math.min(active.column, Math.max(columns - 1, 0));

  // No dependency list, and the reason is the *slots*, not the active cell.
  //
  // What a dependency list cannot see: the slots are replaced wholesale on renders that change
  // neither the active cell nor the grid's size. `HourGrid` keys its day columns by date, so
  // stepping to the next week unmounts all 168 slots and mounts 168 new buttons - same rows, same
  // columns, same active cell - each carrying the browser's default tabindex. An effect keyed on
  // `[row, column, rows, columns]` would not run for that render and the grid would go back to
  // being 168 tab stops. The hook is handed sizes, not identity, so there is nothing honest to put
  // in the list.
  //
  // **What this does *not* handle, contrary to what this comment used to claim: a single slot's
  // button remounting when its create field closes.** `open` is state inside `CreateItemControl`,
  // so opening and closing it re-renders that child alone - `HourGrid` does not re-render, and an
  // effect here does not run, with or without a dependency list. That case is covered elsewhere:
  // closing the field returns focus to the button that replaced it, which fires `onFocusCapture`
  // below; and where the reopened slot was already the active one, the default tabindex a fresh
  // button carries is 0, which is the value it should have had.
  //
  // The cost of re-applying is then a walk over a few hundred DOM nodes comparing two strings -
  // well under the render that preceded it - with nothing allocated per slot and nothing written
  // unless it changed.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }

    // Hoisted: both are constant across the loop, and computing them inside it allocated two
    // strings per slot - 336 of them per pass over a week grid - for two values.
    const activeRow = String(row);
    const activeColumn = String(column);

    for (const slot of container.querySelectorAll<HTMLElement>('[data-roving-row]')) {
      const target = slot.querySelector('button');
      if (target === null) {
        continue;
      }

      const next =
        slot.dataset.rovingRow === activeRow && slot.dataset.rovingColumn === activeColumn ? 0 : -1;

      // Guarded, because an unconditional write is an attribute mutation on all 168 slots to
      // restate what 167 of them already say.
      if (target.tabIndex !== next) {
        target.tabIndex = next;
      }
    }
  });

  function focusCell(nextRow: number, nextColumn: number): void {
    setActive({ row: nextRow, column: nextColumn });

    containerRef.current
      ?.querySelector(
        `[data-roving-row="${String(nextRow)}"][data-roving-column="${String(nextColumn)}"]`,
      )
      ?.querySelector('button')
      ?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const target = event.target;

    // Only a slot's own button moves the roving position. An open create field falls through so
    // Left and Right keep moving the caret in what somebody is typing, and controls that are not
    // slots - the event cards positioned over the same grid - keep their ordinary tab behaviour.
    if (!(target instanceof HTMLButtonElement) || target.closest('[data-roving-row]') === null) {
      return;
    }

    let nextRow = row;
    let nextColumn = column;

    switch (event.key) {
      case 'ArrowDown':
        nextRow = Math.min(row + 1, rows - 1);
        break;
      case 'ArrowUp':
        nextRow = Math.max(row - 1, 0);
        break;
      case 'ArrowRight':
        nextColumn = Math.min(column + 1, columns - 1);
        break;
      case 'ArrowLeft':
        nextColumn = Math.max(column - 1, 0);
        break;
      // The APG's grid convention, taken verbatim: Home and End move along the row, and Ctrl with
      // either jumps to a corner of the whole grid. This used to move the *row* - midnight and
      // 23:00 in the same day - which is a defensible reading of an hour grid and the opposite of
      // what every other grid a person meets does. A key that means "start of this row" everywhere
      // else and "top of this column" here is not discoverable, it is just wrong in a way nobody
      // can be told about; and the two jumps it used to offer are still one keystroke away as
      // Ctrl+Home and Ctrl+End, which additionally reach the far day rather than only the far hour.
      case 'Home':
        nextColumn = 0;
        if (event.ctrlKey || event.metaKey) {
          nextRow = 0;
        }
        break;
      case 'End':
        nextColumn = Math.max(columns - 1, 0);
        if (event.ctrlKey || event.metaKey) {
          nextRow = Math.max(rows - 1, 0);
        }
        break;
      default:
        return;
    }

    // The scroller must not also pan: one press, one movement, and the browser scrolls the focused
    // slot into view on its own.
    event.preventDefault();
    focusCell(nextRow, nextColumn);
  }

  function onFocusCapture(event: FocusEvent<HTMLElement>): void {
    const slot =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-roving-row]')
        : null;

    const rowText = slot?.dataset.rovingRow;
    const columnText = slot?.dataset.rovingColumn;
    if (rowText === undefined || columnText === undefined) {
      return;
    }

    const focusedRow = Number(rowText);
    const focusedColumn = Number(columnText);
    if (
      Number.isInteger(focusedRow) &&
      Number.isInteger(focusedColumn) &&
      (focusedRow !== row || focusedColumn !== column)
    ) {
      setActive({ row: focusedRow, column: focusedColumn });
    }
  }

  return { containerRef, onKeyDown, onFocusCapture };
}
