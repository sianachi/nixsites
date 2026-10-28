import type { CalendarConnection, ExternalCalendar } from '@nix/api-client';
import { Button, Dialog, Field, Input, Select, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { CalendarSyncState } from './use-calendar-sync';

interface LinkCalendarDialogProps {
  readonly connection: CalendarConnection;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

/** Picks one of the account's calendars and creates the container it will be mirrored into. */
export function LinkCalendarDialog({
  connection,
  sync,
  onClose,
}: LinkCalendarDialogProps): ReactElement {
  const { workspaceId, workspace } = useWorkspace();
  const { calendarsOf } = sync;

  const [calendars, setCalendars] = useState<readonly ExternalCalendar[] | null>(null);
  const [calendarId, setCalendarId] = useState('');
  const [title, setTitle] = useState('');
  const [direction, setDirection] = useState('two_way');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  useEffect(() => {
    let current = true;
    void calendarsOf(connection.id).then((listed) => {
      if (!current) {
        return;
      }
      setCalendars(listed.calendars);
      setRefusal(listed.refusal);
      const first = listed.calendars.find((entry) => entry.primary) ?? listed.calendars[0];
      if (first !== undefined) {
        setCalendarId(first.id);
        setTitle(first.name);
        setDirection(first.readOnly ? 'import_only' : 'two_way');
      }
    });
    return () => {
      current = false;
    };
  }, [calendarsOf, connection.id]);

  const chosen = calendars?.find((entry) => entry.id === calendarId) ?? null;

  async function submit(): Promise<void> {
    if (chosen === null || title.trim() === '') {
      setRefusal('Choose a calendar and give its item a name.');
      return;
    }
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await sync.link({
        connectionId: connection.id,
        externalCalendarId: chosen.id,
        workspaceId,
        title: title.trim(),
        direction,
      });
      if (outcome.refusal !== null) {
        setRefusal(outcome.refusal);
        return;
      }
      onClose();
    } finally {
      setInFlight(false);
    }
  }

  return (
    <Dialog
      open
      title={`Link a calendar from ${connection.accountEmail}`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Close without linking"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={inFlight || chosen === null}
            onClick={() => {
              void submit();
            }}
          >
            {inFlight ? 'Linking the calendar' : 'Link calendar'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {calendars === null ? (
          <Text variant="note" role="status">
            Reading the account&apos;s calendars.
          </Text>
        ) : (
          <>
            <Field label="Calendar">
              {(control) => (
                <Select
                  {...control}
                  value={calendarId}
                  onChange={(event) => {
                    const next = calendars.find((entry) => entry.id === event.target.value);
                    setCalendarId(event.target.value);
                    if (next !== undefined) {
                      setTitle(next.name);
                      setDirection(next.readOnly ? 'import_only' : direction);
                    }
                  }}
                >
                  {calendars.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.readOnly ? ' (read-only)' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Item name"
              hint={`A new item with this name is created in ${workspace.name} to hold the events.`}
            >
              {(control) => (
                <Input
                  {...control}
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Direction"
              hint={
                chosen?.readOnly === true
                  ? 'This calendar cannot be written to, so it can only be imported.'
                  : 'Both ways sends the changes you make here to the calendar.'
              }
            >
              {(control) => (
                <Select
                  {...control}
                  value={direction}
                  disabled={chosen?.readOnly === true}
                  onChange={(event) => {
                    setDirection(event.target.value);
                  }}
                >
                  <option value="two_way">Both ways</option>
                  <option value="import_only">Import only</option>
                </Select>
              )}
            </Field>
            {direction === 'two_way' && workspace.kind !== 'personal' ? (
              <Text variant="note">
                {workspace.name} is shared. Anybody who can edit it will be able to change events in
                your calendar through this link.
              </Text>
            ) : null}
          </>
        )}
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
