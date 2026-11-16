import { Button, Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { getNativeMirror } from './native-mirror';
import { setOfflineState, useOfflineState } from './offline-state';

const megabytes = (bytes: number): string =>
  (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });

/**
 * How much room the app's offline copy takes, when it was last brought up to date, and a way to
 * do that now. Renders nothing in a browser.
 */
export function OfflineCopyUsage(): ReactNode {
  const mirror = getNativeMirror();
  const [text, setText] = useState<string | null>(null);
  const { lastSyncedAt, bootOffline } = useOfflineState();

  useEffect(() => {
    if (mirror === null) return;
    let live = true;
    void Promise.all([mirror.usage(), mirror.fileIndex()]).then(
      ([used, index]) => {
        if (live)
          setText(
            `Offline copy: ${megabytes(used.databaseBytes + used.fileBytes)} MB (${String(Object.keys(index).length)} files)`,
          );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // Read again after each sync: a pass changes both figures.
  }, [mirror, lastSyncedAt]);

  if (text === null) return null;
  const synced =
    lastSyncedAt === null
      ? bootOffline
        ? 'Not synced since the app opened: there is no connection.'
        : 'Syncing…'
      : `Last synced at ${new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
  return (
    <div className="flex flex-col items-start gap-2">
      <Text variant="note" as="p" tone="muted">
        {text}. {synced}
      </Text>
      <Button
        variant="secondary"
        disabled={bootOffline}
        onClick={() => {
          setOfflineState({ resyncRequestedAt: Date.now() });
        }}
      >
        Sync now
      </Button>
    </div>
  );
}
