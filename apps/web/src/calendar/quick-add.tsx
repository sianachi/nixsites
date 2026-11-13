import { Button, Field, Icon, Input, Select } from '@nix/ui';
import { Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CalendarPick } from './use-calendar-create-drag';

/**
 * Adding a dated entry from the collated calendar, in place.
 *
 * **Ask which container first, then let the caller resolve that container's own date property**
 * (`use-workspace-calendar.ts`'s `create`), never one guessed from the entries on screen. A bar
 * rather than a dialog: adding is the most common thing done here, a title and Enter should be
 * all it takes, and the bar stays put so several can be added in a row. The title clears after a
 * success, the day and note stay.
 */

export interface CalendarDestination {
  readonly id: string;
  readonly title: string;
}

export interface QuickAddProps {
  /** The containers a new entry may land in: each already placed something, so each has a date property. */
  readonly destinations: readonly CalendarDestination[];

  /** A date chosen on the calendar. A fresh pick moves focus to the title. */
  readonly pick: CalendarPick;
  readonly onClose: () => void;

  /** Makes the item and writes its date. Answers the refusal, or null when it stuck. */
  readonly onCreate: (
    containerId: string,
    title: string,
    start: string,
    end?: string,
  ) => Promise<string | null>;
}

export function QuickAdd(props: QuickAddProps): ReactNode {
  const { destinations, pick, onCreate, onClose } = props;
  const detailsId = useId();

  const [containerId, setContainerId] = useState('');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(pick.day);
  const [time, setTime] = useState(pick.time ?? '');
  const [end, setEnd] = useState(pick.end ?? '');
  const [showDetails, setShowDetails] = useState(Boolean(pick.time ?? pick.end));
  const [seenPick, setSeenPick] = useState(pick);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  if (pick !== seenPick) {
    setSeenPick(pick);
    setDay(pick.day);
    setTime(pick.time ?? '');
    setEnd(pick.end ?? '');
    if (pick.time !== undefined || pick.end !== undefined) setShowDetails(true);
  }

  useEffect(() => {
    titleRef.current?.focus();
  }, [pick]);

  const chosen = destinations.some((d) => d.id === containerId)
    ? containerId
    : (destinations[0]?.id ?? '');

  async function submit(): Promise<void> {
    const named = title.trim();
    if (named.length === 0) {
      setRefusal('Type a title first.');
      titleRef.current?.focus();
      return;
    }

    if (day === '') {
      setRefusal('Choose a date for this event.');
      return;
    }

    setSaving(true);
    setRefusal(null);
    const timed = time !== '';
    const start = `${day}${timed ? `T${time}` : ''}`;
    const finish = timed ? end : end.slice(0, 10);
    const reason =
      finish === ''
        ? await onCreate(chosen, named, start)
        : await onCreate(chosen, named, start, finish);
    setSaving(false);

    if (reason !== null) {
      // Kept as typed: clearing on a refusal would throw away a title somebody just wrote.
      setRefusal(reason);
      return;
    }

    setTitle('');
    titleRef.current?.focus();
  }

  return (
    <form
      aria-label="Add an entry"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-wrap items-end gap-2 rounded-md border border-divider p-3"
    >
      <div className="min-w-0 basis-full sm:flex-1">
        <Field label="Title" error={refusal}>
          {(control) => (
            <Input
              {...control}
              ref={titleRef}
              value={title}
              placeholder="Event name"
              autoComplete="off"
              disabled={saving}
              onChange={(event) => {
                setTitle(event.target.value);
                setRefusal(null);
              }}
            />
          )}
        </Field>
      </div>

      <Field label="Date">
        {(control) => (
          <Input
            {...control}
            type="date"
            value={day}
            disabled={saving}
            onChange={(event) => {
              setDay(event.target.value);
              setRefusal(null);
            }}
          />
        )}
      </Field>

      <Button
        type="button"
        variant="subtle"
        aria-expanded={showDetails}
        aria-controls={detailsId}
        onClick={() => {
          setShowDetails((current) => !current);
        }}
      >
        Event details
      </Button>

      <div
        id={detailsId}
        hidden={!showDetails}
        className="min-w-0 flex-wrap items-end gap-2 not-hidden:flex"
      >
        <Field label="Time">
          {(control) => (
            <Input
              {...control}
              type="time"
              value={time}
              disabled={saving}
              onChange={(event) => {
                if ((time === '') !== (event.target.value === '')) setEnd('');
                setTime(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="End">
          {(control) => (
            <Input
              {...control}
              type={time !== '' ? 'datetime-local' : 'date'}
              value={time !== '' ? end : end.slice(0, 10)}
              disabled={saving}
              onChange={(event) => {
                setEnd(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Calendar">
          {(control) => (
            <Select
              {...control}
              value={chosen}
              disabled={saving}
              onChange={(event) => {
                setContainerId(event.target.value);
              }}
            >
              {destinations.map((destination) => (
                <option key={destination.id} value={destination.id}>
                  {destination.title}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Button type="button" variant="subtle" disabled={saving} onClick={onClose}>
        Close
      </Button>
      <Button
        type="submit"
        variant="secondary"
        disabled={saving}
        className="pointer-coarse:min-h-11"
      >
        <Icon icon={Plus} size="sm" />
        {saving ? 'Adding…' : 'Save event'}
      </Button>
    </form>
  );
}
