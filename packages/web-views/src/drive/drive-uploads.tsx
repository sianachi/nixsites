import { Button, Icon, Text } from '@nix/ui';
import { AlertCircle, Check, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { fileIcon } from './drive-icons';
import type { DriveUpload } from './use-drive-transfers';

/**
 * Each picked file's own outcome while and after it uploads: a failed one names its reason and can
 * be retried without re-picking the rest. The upload API has no byte progress, so a file reads
 * "Uploading" until it is "Done".
 */
export function DriveUploads(props: {
  readonly uploads: readonly DriveUpload[];
  readonly onRetry: (id: string) => void;
  readonly onDismiss: () => void;
}): ReactNode {
  const { uploads, onRetry, onDismiss } = props;
  if (uploads.length === 0) return null;
  const done = uploads.filter((u) => u.status === 'done').length;
  const busy = uploads.some((u) => u.status === 'uploading');
  return (
    <section aria-label="Uploads" className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <Text variant="caption" tone="muted" role="status">
          {`${String(done)} of ${String(uploads.length)} uploaded`}
        </Text>
        {busy ? null : (
          <Button variant="subtle" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      <ul className="flex flex-col" aria-label="Upload progress">
        {uploads.map((upload) => (
          <li key={upload.id} data-enter="" className="flex min-w-0 items-center gap-2 py-1">
            <Icon icon={fileIcon(upload.file.name)} size="sm" />
            <Text variant="body" as="span" className="min-w-0 flex-1 wrap-anywhere">
              {upload.file.name}
            </Text>
            {upload.status === 'uploading' ? (
              <Text variant="caption" as="span" tone="muted" className="flex items-center gap-1">
                <Icon icon={LoaderCircle} size="sm" className="animate-spin" />
                Uploading
              </Text>
            ) : upload.status === 'done' ? (
              <Text variant="caption" as="span" tone="muted" className="flex items-center gap-1">
                <Icon icon={Check} size="sm" />
                Done
              </Text>
            ) : (
              <>
                <Text variant="caption" as="span" className="flex items-center gap-1">
                  <Icon icon={AlertCircle} size="sm" />
                  {`Failed: ${upload.reason ?? 'the upload was refused'}`}
                </Text>
                <Button
                  variant="secondary"
                  aria-label={`Retry ${upload.file.name}`}
                  onClick={() => {
                    onRetry(upload.id);
                  }}
                >
                  Retry
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
