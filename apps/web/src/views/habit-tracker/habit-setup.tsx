import { Button, Checkbox, Field, Input, Select, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import type { HabitTracker, SetHabitInput } from '@nix/api-client';
import { localTimeZone } from '@nix/web-foundation/lib/date-format';
import { dateText, WEEKDAYS } from './habit-days';

export function HabitSetup({
  onCreate,
  initial,
  initialTitle,
  submitLabel = 'Create habit',
  onCancel,
}: {
  readonly onCreate: (title: string, settings: SetHabitInput) => Promise<string | null>;
  readonly initial?: HabitTracker | undefined;
  readonly initialTitle?: string;
  readonly submitLabel?: string;
  readonly onCancel?: () => void;
}): ReactNode {
  const [title, setTitle] = useState(initialTitle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>(initial?.frequency ?? 'daily');
  const [startDate, setStartDate] = useState(initial?.startDate ?? dateText(new Date()));
  const [target, setTarget] = useState(String(initial?.target ?? 1));
  const [unit, setUnit] = useState(initial?.unit ?? 'times');
  const [pending, setPending] = useState(false);
  const [weekdays, setWeekdays] = useState<ReadonlySet<number>>(
    new Set(initial?.weekdays ?? [1, 2, 3, 4, 5]),
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? localTimeZone());
  // Empty means no reminder. Core fires it at this local time, in the habit's own zone, on a
  // scheduled day that has no check-in yet (ADR-0051 section 4).
  const [reminderTime, setReminderTime] = useState(initial?.reminderTime ?? '');
  return (
    <form
      className="grid min-w-0 items-end gap-3 border border-divider p-3 @lg:grid-cols-2 @lg:p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        void onCreate(title.trim(), {
          frequency,
          weekdays: frequency === 'weekly' ? [...weekdays] : [],
          timezone,
          startDate,
          target: Number(target),
          unit: unit.trim() || 'times',
          reminderTime: reminderTime === '' ? null : reminderTime,
        }).then((refusal) => {
          setError(refusal);
          setPending(false);
        });
      }}
    >
      <Field label="Habit name">
        {(control) => (
          <Input
            {...control}
            value={title}
            required
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Frequency">
        {(control) => (
          <Select
            {...control}
            value={frequency}
            onChange={(event) => {
              setFrequency(event.target.value as 'daily' | 'weekly');
            }}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Selected days</option>
          </Select>
        )}
      </Field>
      {frequency === 'weekly' ? (
        <fieldset className="flex flex-wrap gap-2">
          <legend>
            <Text variant="caption">Days</Text>
          </legend>
          {WEEKDAYS.map((name, index) => (
            <Checkbox
              key={name}
              label={name.slice(0, 3)}
              checked={weekdays.has(index === 6 ? 0 : index + 1)}
              onChange={() => {
                setWeekdays((current) => {
                  const next = new Set(current);
                  const value = index === 6 ? 0 : index + 1;
                  if (next.has(value)) next.delete(value);
                  else next.add(value);
                  return next;
                });
              }}
            />
          ))}
        </fieldset>
      ) : null}
      <Field label="Starts">
        {(control) => (
          <Input
            {...control}
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Timezone">
        {(control) => (
          <Input
            {...control}
            value={timezone}
            onChange={(event) => {
              setTimezone(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Reminder time" hint="Leave empty for no reminder.">
        {(control) => (
          <Input
            {...control}
            type="time"
            value={reminderTime}
            onChange={(event) => {
              setReminderTime(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Target">
        {(control) => (
          <Input
            {...control}
            type="number"
            min="0.000001"
            step="any"
            value={target}
            onChange={(event) => {
              setTarget(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Unit">
        {(control) => (
          <Input
            {...control}
            value={unit}
            onChange={(event) => {
              setUnit(event.target.value);
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        disabled={
          pending ||
          title.trim() === '' ||
          !Number.isFinite(Number(target)) ||
          Number(target) <= 0 ||
          Number(target) > 1_000_000 ||
          (frequency === 'weekly' && weekdays.size === 0)
        }
      >
        {pending ? 'Saving' : submitLabel}
      </Button>
      {onCancel === undefined ? null : (
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      )}
      {error ? (
        <Text variant="note" tone="muted" role="alert">
          {error}
        </Text>
      ) : null}
    </form>
  );
}
