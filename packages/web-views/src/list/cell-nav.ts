/**
 * Alt+Arrow cell-to-cell movement for the list's table, kept deliberately apart from ordinary
 * arrow-key handling.
 *
 * **Every list cell already owns its plain arrow keys.** A text field's caret, a native date
 * input's day/month/year stepper, a `<select>`'s option cycling and a checkbox's own key handling
 * all use plain ArrowLeft/Right/Up/Down (and Home/End, for a caret or a stepper) for what they
 * already do. That is exactly why the list cannot borrow the spreadsheet's keyboard ladder
 * (`views/sheet/grid-keys.ts`): the grid paints text and owns every keystroke over it, but the
 * list mounts a real, always-live control per cell (`list-view.tsx`'s "every cell is a control,
 * always drawn as one" rule), and a plain arrow key inside one of those controls has to keep
 * meaning what it already means. Intercepting it here to move between cells instead would
 * silently break every caret, stepper and native picker in the table. Alt is the one modifier none
 * of those controls claims, so Alt+Arrow is free to mean "move cells" without shadowing anything -
 * do not "simplify" this back to plain arrows; that is the bug this module exists to avoid
 * reintroducing.
 *
 * **No focus state, so nothing to restore.** This does not adopt roving tabindex or
 * `aria-activedescendant` - the DOM's normal tab order is untouched, `PropertyInput` is untouched,
 * and the only effect of a move is one imperative `.focus()` call on the destination's own control.
 * A re-sort, an optimistic update or a refusal rollback - the three failure modes `list-view.tsx`'s
 * own docblock names against roving tabindex - have nothing that needs putting back, because
 * nothing about this feature is held in state at all: it reads the live DOM at the moment of the
 * keystroke and nothing else.
 *
 * **Multi-control cells are not a special case.** `multi_select` renders a fieldset of checkboxes
 * and `timestamp` renders a moment field beside a zone picker - both are still one logical cell.
 * Arriving focuses the first focusable element inside the destination cell in DOM order, and
 * leaving is resolved from `closest('td, th')` on whichever control inside the cell the keystroke
 * actually fired from - so a move into or out of either cell needs no rule beyond "find the cell,
 * find its first control."
 *
 * **No announcement.** `a11y/announcer.ts` exists for changes a screen reader would otherwise miss
 * entirely - a refusal, a pane opening. A move here is not one of those: it calls real `.focus()`
 * on a real control, which is exactly the case the browser and the screen reader already handle on
 * their own, the same as clicking or tabbing to it. Nothing else in this table announces an
 * ordinary focus change, and inventing one here would be a new, unasked-for convention that also
 * risks reading the destination control's name twice.
 */

const FOCUSABLE_SELECTOR = 'input, select, textarea, button, a[href], [tabindex]';

export type CellMoveKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

const CELL_MOVE_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

/** Whether a keystroke is one this module moves cells with - callers still gate it on Alt. */
export function isCellMoveKey(key: string): key is CellMoveKey {
  return CELL_MOVE_KEYS.has(key);
}

/**
 * The list cell that owns `origin`, or null when `origin` is not inside one of the table's data
 * cells - a header's sort button, or a control outside the table entirely.
 *
 * A caller uses this to decide whether the keystroke is this feature's to claim *before* calling
 * `preventDefault`: a table header cell is not a list row, and Alt+Arrow there has nothing to do
 * with cell movement.
 */
export function cellFor(origin: Element): HTMLTableCellElement | null {
  const cell = origin.closest('td, th');
  if (!(cell instanceof HTMLTableCellElement)) {
    return null;
  }

  const row = cell.parentElement;
  if (!(row instanceof HTMLTableRowElement) || row.parentElement?.tagName !== 'TBODY') {
    return null;
  }

  return cell;
}

/**
 * Moves DOM focus from `cell` to the cell `key` names, focusing its first focusable control.
 * Answers whether it did, purely so a caller can decide whether there is anything to do next - the
 * keystroke itself is already claimed by the time this is called.
 *
 * A destination that does not exist - past the first or last row, past the first or last column of
 * a row, or a cell with no focusable control at all - does nothing: no move, no side effect,
 * nothing for a caller to announce.
 */
export function moveFocusedCell(cell: HTMLTableCellElement, key: CellMoveKey): boolean {
  const row = cell.parentElement;
  if (!(row instanceof HTMLTableRowElement)) {
    return false;
  }

  const destination = destinationCell(cell, row, key);
  if (destination === null) {
    return false;
  }

  const control = destination.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
  if (control === null) {
    return false;
  }

  control.focus();
  return true;
}

function destinationCell(
  cell: HTMLTableCellElement,
  row: HTMLTableRowElement,
  key: CellMoveKey,
): HTMLTableCellElement | null {
  switch (key) {
    case 'ArrowLeft':
      return asCell(cell.previousElementSibling);
    case 'ArrowRight':
      return asCell(cell.nextElementSibling);
    case 'Home':
      return asCell(row.children[0] ?? null);
    case 'End':
      return asCell(row.children[row.children.length - 1] ?? null);
    case 'ArrowUp':
      return cellAtColumn(previousDataRow(row), columnIndex(row, cell));
    case 'ArrowDown':
      return cellAtColumn(nextDataRow(row), columnIndex(row, cell));
  }
}

function asCell(node: Element | null): HTMLTableCellElement | null {
  return node instanceof HTMLTableCellElement ? node : null;
}

function columnIndex(row: HTMLTableRowElement, cell: HTMLTableCellElement): number {
  return Array.prototype.indexOf.call(row.children, cell);
}

function cellAtColumn(row: HTMLTableRowElement | null, index: number): HTMLTableCellElement | null {
  if (row === null || index < 0) {
    return null;
  }
  return asCell(row.children[index] ?? null);
}

/**
 * The nearest real data row above this one, skipping the virtualizer's `aria-hidden` spacer rows -
 * `<Table>`'s own device for a windowed body's missing height (`packages/ui/src/controls/Table.tsx`).
 */
function previousDataRow(row: HTMLTableRowElement): HTMLTableRowElement | null {
  let sibling = row.previousElementSibling;
  while (sibling !== null) {
    if (sibling instanceof HTMLTableRowElement && sibling.getAttribute('aria-hidden') !== 'true') {
      return sibling;
    }
    sibling = sibling.previousElementSibling;
  }
  return null;
}

function nextDataRow(row: HTMLTableRowElement): HTMLTableRowElement | null {
  let sibling = row.nextElementSibling;
  while (sibling !== null) {
    if (sibling instanceof HTMLTableRowElement && sibling.getAttribute('aria-hidden') !== 'true') {
      return sibling;
    }
    sibling = sibling.nextElementSibling;
  }
  return null;
}
