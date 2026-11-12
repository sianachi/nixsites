import { Button, Text, focusRing } from '@nix/ui';
import { dayFromText, dayLabel } from '@nix/web-collections/core/calendar-dates';
import { readTimestampValue, readerZone } from '@nix/web-collections/core/timestamps';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import type { ItemDialogContextView } from '@nix/web-foundation/lib/item-dialog-context';
import { RescheduleDialog } from '@nix/web-views/calendar/reschedule-dialog';
import { useState, type ReactNode } from 'react';
import { ContextFields, useContextWrite } from './context-fields';

const BRIEF_FIELDS = [
  'location',
  'join_url',
  'meeting_url',
  'attendees',
  'assignee',
  'details',
  'description',
  'prep_notes',
];

function eventDate(value: unknown, zone: string): string | null {
  if (typeof value !== 'string') return null;
  const moment = readTimestampValue({ value }, 'value');
  if (moment !== null) return moment.at.setZone(zone).toFormat('ccc, d LLL yyyy · HH:mm');
  const day = dayFromText(value);
  return day === null ? null : dayLabel(day);
}

function meetingAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const address = new URL(value.trim());
    return address.protocol === 'https:' || address.protocol === 'http:' ? address.href : null;
  } catch {
    return null;
  }
}

export function EventBrief({
  view,
  details,
}: {
  readonly view: Extract<ItemDialogContextView, { kind: 'event' }>;
  readonly details: ItemProperties;
}): ReactNode {
  const [moving, setMoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const write = useContextWrite(details);
  const item = details.item;
  if (item === null || details.error !== null)
    return <ContextFields details={details} fields={[]} />;

  const properties = details.schema?.properties ?? [];
  const startField = properties.find((property) => property.key === view.startKey);
  const fields = BRIEF_FIELDS.filter((key) => properties.some((property) => property.key === key));
  const zone = readerZone();
  const startValue = view.occurrence?.start ?? item.properties[view.startKey];
  const endValue =
    view.occurrence === undefined
      ? view.endKey === null
        ? null
        : item.properties[view.endKey]
      : view.occurrence.end;
  const start = eventDate(startValue, zone);
  const end = eventDate(endValue, zone);
  const join =
    meetingAddress(item.properties.join_url) ??
    meetingAddress(item.properties.meeting_url) ??
    meetingAddress(item.properties.location);
  const placesByTime =
    readTimestampValue(item.properties, view.startKey) !== null || startField?.type === 'timestamp';
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Text variant="body">{start ?? 'No date scheduled'}</Text>
          {end === null ? null : (
            <Text variant="bodySmall" tone="muted">
              Ends {end}
            </Text>
          )}
          {view.occurrence === undefined ? null : (
            <Text variant="note" tone="muted">
              Repeating occurrence
            </Text>
          )}
        </div>
        {join === null ? null : (
          <a
            href={join}
            target="_blank"
            rel="noreferrer"
            className={`rounded-sm text-accent-text underline ${focusRing}`}
          >
            Join event
          </a>
        )}
        {view.occurrence !== undefined ||
        startField === undefined ||
        startField.expression != null ? null : (
          <Button
            variant="secondary"
            disabled={saving}
            onClick={() => {
              setMoving(true);
            }}
          >
            {saving ? 'Saving…' : 'Reschedule'}
          </Button>
        )}
      </div>
      {result === null ? null : (
        <Text variant="note" role={result.error ? 'alert' : 'status'}>
          {result.text}
        </Text>
      )}
      {fields.length === 0 ? null : <ContextFields details={details} fields={fields} />}
      {moving ? (
        <RescheduleDialog
          item={item}
          dateProperty={view.startKey}
          endDateProperty={view.endKey}
          placesByTime={placesByTime}
          zone={zone}
          canRemove={false}
          onCancel={() => {
            setMoving(false);
          }}
          onMove={(values) => {
            setMoving(false);
            setSaving(true);
            setResult(null);
            void write(values).then((refusal) => {
              setSaving(false);
              setResult({ text: refusal ?? 'Event rescheduled.', error: refusal !== null });
            });
          }}
        />
      ) : null}
    </>
  );
}
