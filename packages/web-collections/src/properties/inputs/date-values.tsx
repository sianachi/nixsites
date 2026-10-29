import { Input } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';

import { readTimestampValue, readerZone, writeTimestampValue } from '../../core/timestamps';
import { readDateValue, readPropertyText } from '../../core/container-model';

import { type PropertyInputProps } from './types';
import { ClearButton, controlName, GroupShell, ValueShell } from './shell';
import { COMPLETE_DATE } from './drafts';
import { ReadOnlyValue } from './computed-value';

/**
 * A date or a moment: a date field, and an optional time in the reader's own zone.
 *
 * **All-day by default, timed once a time is given.** Leaving the time empty stores the bare
 * `yyyy-MM-dd` a plain {@link DateValue} would, and filling it in stores an RFC 9557 timestamp
 * built in the reader's own zone - unlike {@link TimestampValue}, whose zone is part of the value
 * and has to be shown and chosen, this property is always read and written in whichever zone the
 * person filling it in is sitting in.
 *
 * **Clearing the time returns the value to all-day.** There is no third "time was cleared" state:
 * a date with no time stored is exactly what an all-day event already looks like, on this property
 * as on the calendar it will be placed on.
 */
export function DateTimeValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const dateRef = useRef<HTMLInputElement>(null);
  const zone = readerZone();

  const stored = readTimestampValue(item.properties, property.key);
  const storedDate = stored === null ? readDateValue(item, property.key) : null;
  const raw = readPropertyText(item, property.key);

  const localDate =
    storedDate ?? (stored === null ? '' : stored.at.setZone(zone).toFormat('yyyy-MM-dd'));
  const localTime = stored === null ? '' : stored.at.setZone(zone).toFormat('HH:mm');

  const [draftDate, setDraftDate] = useState(localDate);
  const [draftTime, setDraftTime] = useState(localTime);
  const [seen, setSeen] = useState(`${localDate}|${localTime}`);
  const [sent, setSent] = useState(`${localDate}|${localTime}`);
  const [incomplete, setIncomplete] = useState(false);

  const seenKey = `${localDate}|${localTime}`;
  if (seenKey !== seen) {
    setSeen(seenKey);
    setDraftDate(localDate);
    setDraftTime(localTime);
    setSent(seenKey);
    setIncomplete(false);
  }

  // Something is stored, and it is neither a calendar date nor a timestamp this field can show.
  if (storedDate === null && stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a date or a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextDate: string, nextTime: string): void {
    const key = `${nextDate}|${nextTime}`;

    // Against what was last handed over rather than against what is stored, for the same reason
    // DateValue compares against `sent`: picking a value commits immediately, and the blur that
    // follows must not commit the same edit a second time.
    if (key === sent) {
      setIncomplete(false);
      return;
    }

    if (nextDate.length === 0) {
      setSent(key);
      setIncomplete(false);
      onCommit(null);
      return;
    }

    if (!COMPLETE_DATE.test(nextDate)) {
      // Half a date is not a date - said out loud rather than stored as a clear, the same rule
      // DateValue applies to a draft mid-edit.
      setIncomplete(true);
      return;
    }

    if (nextTime.length === 0) {
      setSent(key);
      setIncomplete(false);
      onCommit(nextDate);
      return;
    }

    const written = writeTimestampValue(`${nextDate}T${nextTime}`, zone);
    if (written === null) {
      setIncomplete(true);
      return;
    }

    setSent(key);
    setIncomplete(false);
    onCommit(written);
  }

  return (
    <GroupShell
      {...props}
      error={
        error ?? (incomplete ? 'Enter a complete date, and a complete time if you set one.' : null)
      }
    >
      {(group) => (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={dateRef}
            aria-label={group.name('Date', true)}
            aria-describedby={group['aria-describedby']}
            aria-invalid={group['aria-invalid']}
            tabIndex={props.tabIndex}
            type="date"
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draftDate}
            required={property.required}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              setDraftDate(next);

              // A complete date is a finished edit for the date half, the same as DateValue: waiting
              // for a blur would leave somebody looking at a date they picked and did not save.
              if (next !== draftDate && COMPLETE_DATE.test(next)) {
                commit(next, draftTime);
              }
            }}
            onBlur={() => {
              commit(draftDate, draftTime);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(draftDate, draftTime);
            }}
          />

          <Input
            aria-label={group.name('Time')}
            aria-describedby={group['aria-describedby']}
            tabIndex={props.tabIndex}
            type="time"
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draftTime}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.value;
              setDraftTime(next);
              // A half-cleared time reports '' too; committing it would flip the event to all-day
              // mid-edit. The blur commits the bare date if that was meant.
              if (next.length > 0) commit(draftDate, next);
            }}
            onBlur={() => {
              commit(draftDate, draftTime);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(draftDate, draftTime);
            }}
          />

          {localDate.length === 0 ? null : (
            <ClearButton
              name={controlLabel}
              density={density}
              disabled={disabled}
              inputRef={dateRef}
              onClear={() => {
                setDraftDate('');
                setDraftTime('');
                commit('', '');
              }}
            />
          )}
        </div>
      )}
    </GroupShell>
  );
}

export function DateValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, error = null, density = 'panel' } = props;

  // The stored text, straight in and straight back out. A date property carries no time and no zone
  // deliberately - "the 3rd" must stay the 3rd for a reader in another zone - and building a Date
  // from it to fill the field is exactly how it becomes the 2nd.
  const stored = readDateValue(item, property.key) ?? '';
  const raw = readPropertyText(item, property.key);

  const [draft, setDraft] = useState(stored);
  const [seen, setSeen] = useState(stored);
  const [sent, setSent] = useState(stored);
  const [incomplete, setIncomplete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (stored !== seen) {
    setSeen(stored);
    setDraft(stored);
    setSent(stored);
    setIncomplete(false);
  }

  function send(value: string | null): void {
    setSent(value ?? '');
    onCommit(value);
  }

  // Something is stored, and it is not a calendar date. Showing an empty date field over it would
  // claim the property is unset and offer to overwrite it without ever saying what was there.
  if (stored.length === 0 && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a date this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(): void {
    // Against what was last handed over rather than against what is stored. Picking a date commits
    // immediately, and the blur that follows would otherwise commit the same value a second time -
    // one edit, two requests, and on a slow link two chances for them to land out of order.
    if (draft === sent) {
      setIncomplete(false);
      return;
    }

    if (draft.length === 0) {
      send(null);
      return;
    }

    if (COMPLETE_DATE.test(draft)) {
      send(draft);
      return;
    }

    // Half a date is not a date. A field mid-edit reports an empty value in every browser that
    // draws its own picker, so an incomplete draft is said out loud rather than stored as a clear.
    setIncomplete(true);
  }

  return (
    <ValueShell
      {...props}
      error={error ?? (incomplete ? 'Enter a date as year, month and day.' : null)}
    >
      {(control) => (
        <div className="flex items-center gap-2">
          <Input
            {...control}
            ref={inputRef}
            tabIndex={props.tabIndex}
            type="date"
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draft}
            required={property.required}
            disabled={disabled}
            className="min-w-0 flex-1"
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              setIncomplete(false);

              // A complete date is a finished edit: choosing one from the field's own picker produces
              // exactly this and nothing follows it, so waiting for a blur would leave somebody
              // looking at a date they picked and did not save.
              if (next !== sent && COMPLETE_DATE.test(next)) {
                send(next);
              }
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              // Puts back what was last handed over, as the text fields do.
              if (event.key === 'Escape') {
                setDraft(sent);
                setIncomplete(false);
              }

              // Enter is the explicit "done", as in the text fields.
              if (event.key === 'Enter') commit();
            }}
          />
          {stored.length === 0 ? null : (
            <ClearButton
              name={controlName(density, item, property)}
              density={density}
              disabled={disabled}
              inputRef={inputRef}
              onClear={() => {
                setDraft('');
                send(null);
              }}
            />
          )}
        </div>
      )}
    </ValueShell>
  );
}
