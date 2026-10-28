import { type ReactNode } from 'react';

import { cn } from '../lib/cn';
import { focusRing } from '../primitives/interaction';

/**
 * <Segmented> - a small set of alternatives, one of them current.
 *
 * For choosing between two or three ways of looking at the same thing: the panes of a side panel,
 * the grain of a calendar. Not for navigation, and not for a choice with more than a few members -
 * past four it is a `<Select>` that has been stretched out.
 *
 * **`aria-current`, not a tablist.** These are buttons that change what is beside them, and calling
 * them tabs would owe roving tabindex, arrow-key movement between them, and a matching set of
 * panels wired by id. `<ViewSwitcher>` settled the same question the same way, for the same reason:
 * a screen reader announcing "current" is accurate, and announcing "tab, 2 of 3" while the arrow
 * keys do nothing is not.
 *
 * The current option is marked by more than colour. A person who cannot see the fill still gets
 * `aria-current`, which is the half that reaches them.
 *
 * Each segment holds a 44px minimum height on a coarse pointer, the same `--control-lg` touch step
 * `<Button>` grows to, rather than the roughly 27px the compact padding leaves it under a fine one.
 */

interface SegmentedOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

export interface SegmentedProps<TValue extends string> {
  /** What the set as a whole is for. Becomes the group's accessible name. */
  readonly label: string;

  readonly options: readonly SegmentedOption<TValue>[];

  readonly value: TValue;

  readonly onChange: (value: TValue) => void;

  /**
   * The id of an element that explains what the choice does, wired to the group as
   * `aria-describedby`.
   *
   * For the common case of a sentence rendered beneath the control - "cards keep their aspect
   * ratio", "hours are shown in your timezone". Without this the note is a loose paragraph that
   * happens to sit nearby: a person reading with a screen reader lands on the group, hears three
   * unexplained words, and never meets the sentence that would have explained them. The label is
   * still the name; this is the description, and the two are separate slots for a reason.
   */
  readonly describedBy?: string;

  /** Layout only. */
  readonly className?: string;
}

export function Segmented<TValue extends string>(props: SegmentedProps<TValue>): ReactNode {
  const { label, options, value, onChange, describedBy, className } = props;

  return (
    <div
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-0.5 rounded-md bg-surface p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const current = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            aria-current={current ? 'true' : undefined}
            onClick={() => {
              onChange(option.value);
            }}
            className={cn(
              'min-w-0 flex-1 rounded-sm px-2 py-1 text-sm wrap-anywhere transition-colors',
              'any-pointer-coarse:min-h-(--control-lg) any-pointer-coarse:min-w-(--control-lg) any-pointer-coarse:text-md',
              focusRing,
              current
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
