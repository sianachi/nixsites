import { Input } from '@nix/ui';
import { useRef, useState, type ReactNode } from 'react';

import { readTimestampValue, readerZone, writeTimestampValue } from '../../core/timestamps';
import { readPropertyText } from '../../core/container-model';

import { type PropertyInputProps } from './types';
import { ChoiceSelect } from './choice-select';
import { ClearButton, GroupShell, controlName } from './shell';
import { useDraft } from './drafts';
import { ReadOnlyValue } from './computed-value';

/**
 * A moment: a local time, and the zone it means.
 *
 * **The zone is shown and editable, not assumed.** A time with no zone is a time that changes
 * meaning when somebody else reads it, and the reader's own zone is only the right default - never
 * the right answer for a thing scheduled somewhere else.
 *
 * The offset is never typed. It is derived from the wall time and the zone when the value is
 * written, so it cannot disagree with them - which is exactly what the server refuses.
 */
export function TimestampValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const inputRef = useRef<HTMLInputElement>(null);

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = stored?.zone ?? readerZone();

  // The wall clock as the local `datetime-local` field wants it, in the value's own zone rather
  // than the reader's - editing a meeting set in another city should show the time it was set for.
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const [draft, setDraft] = useState(local);
  const [draftZone, setDraftZone] = useState(zone);
  const storedKey = `${local}|${zone}`;
  const [seen, setSeen] = useState(storedKey);
  const [sent, setSent] = useState(storedKey);

  if (storedKey !== seen) {
    setSeen(storedKey);
    if (`${draft}|${draftZone}` === sent) {
      setDraft(local);
      setDraftZone(zone);
    }
    setSent(storedKey);
  }

  // Something is stored and it is not a timestamp. Showing an empty field over it would claim the
  // property is unset and offer to overwrite it without ever saying what was there.
  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string, nextZone: string): void {
    const key = `${nextLocal}|${nextZone}`;
    if (nextLocal.length === 0) {
      setSent(key);
      onCommit(null);
      return;
    }

    const written = writeTimestampValue(nextLocal, nextZone);
    if (written !== null) {
      setSent(key);
      onCommit(written);
    }
  }

  return (
    <GroupShell {...props}>
      {(group) => (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              type="datetime-local"
              aria-label={group.name('Date and time', true)}
              aria-describedby={group['aria-describedby']}
              aria-invalid={group['aria-invalid']}
              // A table cell carries one control, so its zone is read from here instead.
              title={density === 'cell' ? draftZone : undefined}
              tone={density === 'cell' ? 'plain' : 'default'}
              value={draft}
              disabled={disabled}
              className="min-w-0 flex-1"
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              onBlur={() => {
                commit(draft, draftZone);
              }}
            />
            {stored === null ? null : (
              <ClearButton
                name={controlLabel}
                density={density}
                disabled={disabled}
                inputRef={inputRef}
                onClear={() => {
                  setDraft('');
                  commit('', draftZone);
                }}
              />
            )}
          </div>

          {/* The zone is edited in the panel and on a card; a table row would carry ~420 options
              per cell for a choice made once. */}
          {density === 'cell' ? null : (
            <ChoiceSelect
              density={density}
              control={{
                'aria-label': group.name('Time zone'),
                'aria-describedby': group['aria-describedby'],
                'aria-invalid': group['aria-invalid'],
              }}
              value={draftZone}
              disabled={disabled}
              onChange={(next) => {
                setDraftZone(next);
                commit(draft, next);
              }}
            >
              {zoneOptions(draftZone).map((zoneName) => (
                <option key={zoneName} value={zoneName}>
                  {zoneName}
                </option>
              ))}
            </ChoiceSelect>
          )}
        </>
      )}
    </GroupShell>
  );
}

/**
 * When to be reminded: a date and time in the reader's own zone, and a way to clear it.
 *
 * **The reader's zone, not a zone picker.** A reminder is an instant somebody is told about, on
 * whatever device they are holding; asking which city's clock it follows is a question about a
 * meeting, not about a nudge. So the field shows the stored instant converted to the reader's clock,
 * and writes what they pick in that same zone - still as RFC 9557 with its zone, which is the shape
 * Core's `PropertyType.Reminder` validation accepts (the same check a timestamp gets).
 *
 * **Clearing is its own control.** An empty `datetime-local` is easy to produce by accident on some
 * browsers; a button that says "Clear reminder" is not.
 */
export function ReminderValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false, density = 'panel' } = props;
  const controlLabel = controlName(density, item, property);
  const inputRef = useRef<HTMLInputElement>(null);

  const stored = readTimestampValue(item.properties, property.key);
  const raw = readPropertyText(item, property.key);
  const zone = readerZone();
  const local = stored === null ? '' : stored.at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm");

  const { draft, setDraft, send } = useDraft(local, onCommit);
  // When the field was drawn, for saying a reminder's time has passed. Read once rather than on
  // every render, which is what a render has to be: the same output for the same input.
  const [openedAt] = useState(() => Date.now());

  if (stored === null && raw.length > 0) {
    return (
      <ReadOnlyValue
        {...props}
        note={`Stored as "${raw}", which is not a time this field can show. It is left as it is rather than being overwritten.`}
      />
    );
  }

  function commit(nextLocal: string): void {
    if (nextLocal === local) return;
    if (nextLocal.length === 0) {
      send(nextLocal, null);
      return;
    }
    const written = writeTimestampValue(nextLocal, zone);
    if (written !== null) send(nextLocal, written);
  }

  const passed = stored !== null && stored.at.toMillis() <= openedAt;

  return (
    <GroupShell
      {...props}
      {...(density === 'cell'
        ? {}
        : {
            hint: passed
              ? `This time has passed, so it will not remind you again. Times are in ${zone}.`
              : `You will be notified at this time, in ${zone}.`,
          })}
    >
      {(group) => (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            ref={inputRef}
            type="datetime-local"
            aria-label={group.name('Date and time', true)}
            aria-describedby={group['aria-describedby']}
            aria-invalid={group['aria-invalid']}
            tone={density === 'cell' ? 'plain' : 'default'}
            value={draft}
            disabled={disabled}
            className="min-w-0 flex-1"
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onBlur={() => {
              commit(draft);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit(draft);
              }
            }}
          />
          {stored === null ? null : (
            <ClearButton
              name={controlLabel}
              density={density}
              disabled={disabled}
              inputRef={inputRef}
              onClear={() => {
                setDraft('');
                send('', null);
              }}
            />
          )}
        </div>
      )}
    </GroupShell>
  );
}

/**
 * The zones offered, with the value's own always among them.
 *
 * Read from the platform rather than shipped: the browser already carries the IANA database, and a
 * second copy would be bytes spent on something already installed. A build whose runtime cannot
 * enumerate them still offers the two that matter - the reader's, and whatever is already stored.
 */
function zoneOptions(current: string): readonly string[] {
  const all = (platformZones ??= listZones());
  return all.includes(current) ? all : [current, ...all];
}

let platformZones: readonly string[] | undefined;

function listZones(): readonly string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return supported.length > 0 ? supported : [readerZone()];
}
