import type { CalendarConnection } from '@nix/api-client';
import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import type { CalendarSyncState } from './use-calendar-sync';

interface ConfirmDisconnectDialogProps {
  readonly connection: CalendarConnection;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

export function ConfirmDisconnectDialog({
  connection,
  sync,
  onClose,
}: ConfirmDisconnectDialogProps): ReactElement {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);

  async function confirm(): Promise<void> {
    setInFlight(true);
    setRefusal(null);
    try {
      const outcome = await sync.disconnect(connection.id);
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
      title={`Disconnect ${connection.accountEmail}?`}
      onClose={() => {
        if (!inFlight) {
          onClose();
        }
      }}
      closeLabel="Keep the account connected"
      actions={
        <>
          <Button variant="secondary" disabled={inFlight} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={inFlight}
            onClick={() => {
              void confirm();
            }}
          >
            {inFlight ? 'Disconnecting the account' : 'Disconnect account'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Text variant="bodySmall">
          Its linked calendars stop syncing. Their notes stay in the workspace and stay protected
          until you unlink each calendar.
        </Text>
        {refusal === null ? null : (
          <Text variant="note" role="alert">
            {refusal}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
