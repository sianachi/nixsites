import { Button, Field, Icon, Input, Select, Text } from '@nix/ui';
import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

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

  /** The day the new entry starts on, `yyyy-MM-dd`, until the reader picks another. */
  readonly day: string;

  /** A day chosen elsewhere on the page ("+ Add" on an agenda day); a new object each time. */
  readonly pick?: { readonly day: string } | null | undefined;

  /** Makes the item and writes its date. Answers the refusal, or null when it stuck. */
  readonly onCreate: (containerId: string, title: string, day: string) => Promise<string | null>;
}

/** What a reader is told instead of an empty menu. */
const NO_ELIGIBLE_CONTAINER =
  'No note here offers a calendar with a date property to create into. Give one a calendar view ' +
  'and a date property, and it will appear here as somewhere a new entry can land.';

export function QuickAdd(props: QuickAddProps): ReactNode {
  const { destinations, day, pick = null, onCreate } = props;

  const [containerId, setContainerId] = useState('');
  const [title, setTitle] = useState('');
  // Null follows `day` (where the reader is looking); a typed or picked day overrides it.
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  const [seenPick, setSeenPick] = useState(pick);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  if (pick !== seenPick) {
    setSeenPick(pick);
    if (pick !== null) {
      setDayDraft(pick.day);
    }
  }

  useEffect(() => {
    if (pick !== null) {
      titleRef.current?.focus();
    }
  }, [pick]);

  if (destinations.length === 0) {
    return (
      <Text as="span" variant="note" tone="muted">
        {NO_ELIGIBLE_CONTAINER}
      </Text>
    );
  }

  const chosen = destinations.some((d) => d.id === containerId)
    ? containerId
    : (destinations[0]?.id ?? '');

  async function submit(): Promise<void> {
    const named = title.trim();
    if (named.length === 0) {
      setRefusal('Type a title first.');
      return;
    }

    setSaving(true);
    setRefusal(null);
    const reason = await onCreate(chosen, named, dayDraft ?? day);
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
      className="flex flex-wrap items-end gap-2"
    >
      <div className="min-w-56 flex-1">
        <Field label="Title" error={refusal}>
          {(control) => (
            <Input
              {...control}
              ref={titleRef}
              value={title}
              placeholder="Add an entry, then Enter"
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
            value={dayDraft ?? day}
            disabled={saving}
            onChange={(event) => {
              setDayDraft(event.target.value);
            }}
          />
        )}
      </Field>

      <Field label="Note">
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

      <Button
        type="submit"
        variant="secondary"
        disabled={saving}
        className="pointer-coarse:min-h-11"
      >
        <Icon icon={Plus} size="sm" />
        {saving ? 'Adding…' : 'Add'}
      </Button>
    </form>
  );
}
