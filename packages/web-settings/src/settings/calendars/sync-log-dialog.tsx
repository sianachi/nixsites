import type { CalendarLink, CalendarSyncLogEntry } from '@nix/api-client';
import { Button, Dialog, Table, Text } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { formatMoment } from './calendar-labels';
import type { CalendarSyncState } from './use-calendar-sync';

interface SyncLogDialogProps {
  readonly link: CalendarLink;
  readonly sync: CalendarSyncState;
  readonly onClose: () => void;
}

/** The newest things a link's sync did, so a missing or doubled event can be explained. */
export function SyncLogDialog({ link, sync, onClose }: SyncLogDialogProps): ReactElement {
  const { logOf } = sync;
  const [entries, setEntries] = useState<readonly CalendarSyncLogEntry[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void logOf(link.id).then((read) => {
      if (current) {
        setEntries(read.entries);
        setRefusal(read.refusal);
      }
    });
    return () => {
      current = false;
    };
  }, [logOf, link.id]);

  const columns = [
    {
      key: 'at',
      header: 'When',
      rowHeader: true,
      cell: (entry: CalendarSyncLogEntry) => formatMoment(entry.at),
    },
    {
      key: 'direction',
      header: 'Direction',
      cell: (entry: CalendarSyncLogEntry) =>
        entry.direction === 'pull' ? 'From calendar' : 'To calendar',
    },
    { key: 'action', header: 'What', cell: (entry: CalendarSyncLogEntry) => entry.action },
    { key: 'detail', header: 'Detail', cell: (entry: CalendarSyncLogEntry) => entry.detail },
  ] as const;

  return (
    <Dialog
      open
      title={`Sync log of ${link.name}`}
      onClose={onClose}
      closeLabel="Close the log"
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {refusal === null ? (
        <div
          className="min-w-0 overflow-x-auto"
          role="region"
          aria-label="Calendar sync log table"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Justification: keyboard users need to scroll sync log columns horizontally.
          tabIndex={0}
        >
          <Table
            caption="The newest fifty sync events, newest first."
            columns={columns}
            rows={entries ?? []}
            rowKey={(entry) => entry.id}
            loading={entries === null}
            loadingMessage="Reading the sync log."
            emptyMessage="Nothing has been synced yet."
          />
        </div>
      ) : (
        <Text variant="note" role="alert">
          {refusal}
        </Text>
      )}
    </Dialog>
  );
}
