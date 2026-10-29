import { Button, Dialog, Field, Input } from '@nix/ui';
import { DateTime } from 'luxon';
import { useRef, useState, type ReactNode } from 'react';

import { readDateValue, type Item } from '../../collections/core/container-model';
import { readTimestampValue, writeTimestampValue } from '../../collections/core/timestamps';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { FreeSlotHint } from './free-slot-hint';
import { suggestSlot } from './schedule-slot';
import { durationLabel } from './span-gesture';

/** The lengths offered in one tap, in minutes. The same quarter-hour steps a drag snaps to. */
const LENGTHS = [15, 30, 45, 60, 90, 120] as const;

/**
 * The keyboard road to the same write a drag performs, in a modal.
 *
 * Shared by every place an item sits on a calendar and can be moved: the month card, a timed item
 * placed on an hour grid, and the collated calendar's own month cell. All three used to answer only
 * to a pointer - a drag was the sole way to reschedule a card that had already landed somewhere - so
 * this is the one dialog every caller opens instead of reaching for its own copy.
 *
 * A modal rather than a form swapped into the card's place, because the card's place is often a
 * `w-[6.5rem]` month column and a native date input needs roughly 120px to draw its value - the old
 * inline form rendered a control that could not show the date being typed into it.
 *
 * The draft starts as the date the item has now, when it has one. What the form must not do is
 * guess: a draft that is not a `yyyy-MM-dd` date, or not a full `datetime-local` value, is refused
 * here, in the field that can say so, rather than written and refused by Core.
 *
 * **A view with an end-date property configured gets a second field, for the same reason the hour
 * grid stopped being a pointer-only surface.** A timed item's length used to answer to nothing at
 * all - no drag resized it, because nothing drew it as a shape with two ends to begin with, and no
 * keyboard path existed either. `endDateProperty` names the property that closes the span; passing
 * it draws a matching end field, prefilled from the item, and `submit` refuses an end that lands
 * before the start rather than sending the pair to Core to be refused.
 */

export interface RescheduleDialogProps {
  readonly item: Item;

  /** The property this dialog writes, for reading the value the item has now. */
  readonly dateProperty: string;

  /**
   * Whether the property holds a moment rather than a day.
   *
   * When it does, this dialog takes an hour as well - because an hour slot accepts a drop, and a
   * capability the pointer has and the keyboard does not is the thing ADR-0009 removed.
   */
  readonly placesByTime: boolean;

  /** The reader's zone, which a typed wall-clock time means what it says in. */
  readonly zone: string;
  readonly onCancel: () => void;

  /**
   * Writes the draft, as one bag of properties - `dateProperty` always, and `endDateProperty` too
   * when this dialog was given one. A single call rather than two, so a caller that writes through
   * one `setProperties` request stores the span as one edit rather than as a start that could land
   * and an end that could still be refused.
   */
  readonly onMove: (values: Record<string, string | null>) => void;

  /**
   * Whether "Remove date" is offered.
   *
   * Defaults to true - the ordinary case, where dropping a card in the unscheduled list is the same
   * write this button reaches. The collated calendar has no unscheduled list to be the counterpart
   * of that write, so it passes false rather than offering a button that would silently do nothing.
   */
  readonly canRemove?: boolean;

  /**
   * The property that closes the span this item starts, or null/undefined when the view has none.
   *
   * Undefined and null both mean "no end field" - most callers (the month card, the collated
   * calendar) have never had a notion of a span, and a calendar view that has one names it here as
   * `null` until somebody configures it. Either way this dialog draws exactly what it drew before
   * the end field existed.
   *
   * The end is assumed to share `dateProperty`'s shape - both a day or both a moment - which is what
   * every caller that sets one also assumes when it decides `placesByTime`. A view whose two
   * properties disagree on shape is a configuration the editor does not offer today.
   */
  readonly endDateProperty?: string | null;

  /**
   * Every item the calendar holds, when it wants the dialog to suggest the next free slot: the
   * container's unfiltered children, and only when none were left unloaded - a filter or a
   * truncated page would hide an item and make its time look free.
   *
   * Only read for a calendar that places by time - a day has no slot to be free in - and only as
   * a suggestion: "Use" fills the fields, Move still writes. Absent, no slot is offered, which is
   * what the collated calendar wants, since it shows several containers and a slot free in one
   * proves nothing about the others.
   */
  readonly siblings?: readonly Item[] | undefined;
}

/**
 * What the reschedule field starts with: the value the item already has, in the shape the control
 * takes.
 *
 * A `datetime-local` input refuses anything that is not a bare wall clock, so a stored moment is
 * converted into the reader's zone and stripped of its offset first - the same reading the grid
 * places it by, so the field agrees with the row the card is sitting on.
 */
function readDraft(item: Item, key: string, placesByTime: boolean, zone: string): string {
  if (!placesByTime) {
    return readDateValue(item, key) ?? '';
  }

  const moment = readTimestampValue(item.properties, key);
  return moment === null ? '' : moment.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");
}

/** The shape a wall-clock or bare-date draft must have to be worth writing at all. */
const TIME_DRAFT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
const DATE_DRAFT = /^\d{4}-\d{2}-\d{2}$/;

export function RescheduleDialog(props: RescheduleDialogProps): ReactNode {
  const {
    item,
    dateProperty,
    placesByTime,
    zone,
    onCancel,
    onMove,
    canRemove = true,
    endDateProperty = null,
    siblings,
  } = props;
  const [draft, setDraft] = useState(() => readDraft(item, dateProperty, placesByTime, zone));
  const [error, setError] = useState<string | null>(null);
  const [endDraft, setEndDraft] = useState(() =>
    endDateProperty === null ? '' : readDraft(item, endDateProperty, placesByTime, zone),
  );
  const [endError, setEndError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  // Worked out once, when the dialog opens: the suggestion is about the moment somebody asked, and
  // a slot that slid forward while they read it would be a moving target. A state initialiser
  // rather than a render-time call because the search walks every sibling's span and the dialog
  // re-renders on every keystroke in its fields.
  const viewSuggestions = useViewSuggestionPreference((state) => state.setting);
  const [slot] = useState(() =>
    placesByTime && siblings !== undefined
      ? suggestSlot(item, siblings, dateProperty, endDateProperty, Date.now(), zone)
      : null,
  );

  function submit(): void {
    let startValue: string;

    if (placesByTime) {
      // What `datetime-local` produces, and what the hour slots write: a wall clock, which the
      // reader's zone turns into a moment. Seconds are optional in the control's own output.
      if (!TIME_DRAFT.test(draft)) {
        setError('Enter a date and a time of day.');
        return;
      }

      const stored = writeTimestampValue(draft, zone);
      if (stored === null) {
        setError('That is not a time this calendar can place.');
        return;
      }

      startValue = stored;
    } else {
      if (!DATE_DRAFT.test(draft)) {
        setError('Enter a date as year, month and day.');
        return;
      }

      startValue = draft;
    }

    const values: Record<string, string | null> = { [dateProperty]: startValue };

    if (endDateProperty !== null) {
      // Blank means "no end", written explicitly rather than left alone - a caller that opens this
      // dialog on an item with an end and clears the field means to take it off, the same way
      // clearing the start and pressing Move does.
      if (endDraft === '') {
        values[endDateProperty] = null;
      } else if (placesByTime) {
        if (!TIME_DRAFT.test(endDraft)) {
          setEndError('Enter a date and a time of day.');
          return;
        }

        // Compared as drafts, before either is written: both are wall-clock text in the same
        // reader zone, so the ordering a naive `DateTime` gives them is the ordering the two rows
        // occupy in the grid, with no zone conversion able to disagree with it.
        if (DateTime.fromISO(endDraft) < DateTime.fromISO(draft)) {
          setEndError('The end must be after the start.');
          return;
        }

        const storedEnd = writeTimestampValue(endDraft, zone);
        if (storedEnd === null) {
          setEndError('That is not a time this calendar can place.');
          return;
        }

        values[endDateProperty] = storedEnd;
      } else {
        if (!DATE_DRAFT.test(endDraft)) {
          setEndError('Enter a date as year, month and day.');
          return;
        }

        // Bare `yyyy-MM-dd` text sorts the same lexically as it does by calendar day, so no date
        // library is needed to tell an all-day span's end from a day before its start.
        if (endDraft < draft) {
          setEndError('The end must be on or after the start.');
          return;
        }

        values[endDateProperty] = endDraft;
      }
    }

    onMove(values);
  }

  return (
    <Dialog
      open
      title={`Reschedule ${item.title || 'Untitled'}`}
      onClose={onCancel}
      // The dialog's whole purpose is one field, which is the case Dialog documents initialFocus
      // for: landing on the element itself would make the first press a Tab nobody needed.
      initialFocus={fieldRef}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Justification: the handler adds no interaction of its own - the field and buttons inside stay the controls - it only stops an Escape press, already translated to the dialog's cancel, from bubbling on to outer layers (ADR-0029). */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={(event) => {
          // ADR-0029's layering rule: the innermost open layer owns Escape and stops it where it
          // is handled. The platform translates this very keydown into the dialog's `cancel`
          // event, which is what closes it - so propagation is stopped, keeping the press from
          // also reaching a window-level listener like the sidebar drawer's, but the default is
          // NOT prevented, because preventing it here would suppress the cancel event itself.
          if (event.key === 'Escape') {
            event.stopPropagation();
          }
        }}
        className="flex flex-col gap-3"
      >
        <Field label={placesByTime ? 'New date and time' : 'New date'} error={error}>
          {(control) => (
            <Input
              {...control}
              ref={fieldRef}
              type={placesByTime ? 'datetime-local' : 'date'}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>

        {slot === null || viewSuggestions === 'off' ? null : (
          <FreeSlotHint
            label={slot.label}
            onUse={() => {
              setDraft(slot.start);
              setError(null);
              if (endDateProperty !== null) {
                setEndDraft(slot.end);
                setEndError(null);
              }
              // Focus the start it just filled, so the new value is read out where it now sits
              // rather than the change happening silently behind the button.
              fieldRef.current?.focus();
            }}
          />
        )}

        {endDateProperty === null ? null : (
          // Only when the view names a second property to close the span with - a view that never
          // configured one draws exactly what it drew before this field existed. Blank is a valid
          // draft here (see `submit`'s own comment): the item may have no end yet, and the field
          // opens empty rather than guessing one.
          <Field label={placesByTime ? 'New end date and time' : 'New end date'} error={endError}>
            {(control) => (
              <Input
                {...control}
                type={placesByTime ? 'datetime-local' : 'date'}
                value={endDraft}
                onChange={(event) => {
                  setEndDraft(event.target.value);
                  setEndError(null);
                }}
              />
            )}
          </Field>
        )}

        {/* A length in one tap. Typing an end into a `datetime-local` field is the slow way to
            say "half an hour", and on a phone - where an item cannot be dragged to move it - this
            dialog is the main road to a length at all. Each sets the end from the start as it is
            drafted now; Move still does the writing. */}
        {endDateProperty !== null && placesByTime ? (
          <div role="group" aria-label="Length" className="flex flex-wrap items-center gap-1">
            {LENGTHS.map((minutes) => (
              <Button
                key={minutes}
                type="button"
                variant="secondary"
                className="py-1 text-sm"
                onClick={() => {
                  const start = DateTime.fromISO(draft);
                  if (!start.isValid) {
                    setError('Enter a date and a time of day.');
                    return;
                  }
                  setEndDraft(start.plus({ minutes }).toFormat("yyyy-MM-dd'T'HH:mm"));
                  setEndError(null);
                }}
              >
                {durationLabel(minutes)}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-1">
          <Button type="submit" className="py-1 text-sm">
            Move
          </Button>

          {canRemove ? (
            <Button
              variant="secondary"
              className="py-1 text-sm"
              onClick={() => {
                // Parity with dropping a card into the unscheduled list. A gesture the mouse has
                // and the keyboard does not is a gesture half the people here cannot perform. Takes
                // the end off along with the start - a span with no start is not a span, so leaving
                // a stale end behind would be a length nothing begins.
                onMove(
                  endDateProperty === null
                    ? { [dateProperty]: null }
                    : { [dateProperty]: null, [endDateProperty]: null },
                );
              }}
            >
              Remove date
            </Button>
          ) : null}

          <Button variant="ghost" className="py-1 text-sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
