import { Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { getNativeMirror } from './native-mirror';

const megabytes = (bytes: number): string =>
  (bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 1 });

/** How much room the iOS app's offline copy takes. Renders nothing in a browser. */
export function OfflineCopyUsage(): ReactNode {
  const mirror = getNativeMirror();
  const [text, setText] = useState<string | null>(null);

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
  }, [mirror]);

  return text === null ? null : (
    <Text variant="note" as="p" tone="muted">
      {text}
    </Text>
  );
}
