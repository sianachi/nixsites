import { Text, focusRing } from '@nix/ui';
import type { ReactNode } from 'react';

/**
 * Which notes the calendar is showing.
 *
 * **Checkboxes in a named group, not a listbox or a row of toggle buttons.** Several of these can
 * be on at once and each is independent, which is what a checkbox means and what a screen reader
 * will say about one. A `<Segmented>` would be wrong for the same reason it is right for the grain:
 * that picks one of three, this picks any of many.
 *
 * **Nothing checked means everything**, and the group says so rather than leaving a reader to infer
 * it from an empty selection - which is equally consistent with showing nothing.
 */

export interface NoteFilterProps {
  /** The notes that placed something in this window. Empty when there is nothing to filter. */
  readonly options: readonly { readonly id: string; readonly title: string }[];

  /** The current selection. Empty means every note. */
  readonly selected: ReadonlySet<string>;

  readonly onChange: (selected: ReadonlySet<string>) => void;
}

export function NoteFilter({ options, selected, onChange }: NoteFilterProps): ReactNode {
  if (options.length === 0 && selected.size === 0) {
    return null;
  }

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  return (
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Notes to show</legend>

      <Text as="span" variant="note" tone="muted">
        Notes:
      </Text>

      {options.map((option) => (
        <label
          key={option.id}
          className={`${focusRing} flex items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-surface`}
        >
          <input
            type="checkbox"
            checked={selected.has(option.id)}
            onChange={() => {
              toggle(option.id);
            }}
          />
          <Text as="span" variant="note">
            {option.title}
          </Text>
        </label>
      ))}

      {selected.size > 0 && (
        <button
          type="button"
          onClick={() => {
            onChange(new Set());
          }}
          className={`${focusRing} rounded-sm px-1.5 py-0.5 hover:bg-surface`}
        >
          <Text as="span" variant="note" tone="accent">
            Show all
          </Text>
        </button>
      )}

      {/* Said rather than implied. An empty selection and a selection showing nothing look the same
          on a grid, and only one of them is what happened. */}
      <Text as="span" variant="note" tone="muted" aria-live="polite">
        {selected.size === 0
          ? 'Showing every note'
          : options.length === 0
            ? 'No events from the selected calendars'
            : `Showing ${String(options.filter((option) => selected.has(option.id)).length)} of ${String(options.length)} notes`}
      </Text>
    </fieldset>
  );
}
