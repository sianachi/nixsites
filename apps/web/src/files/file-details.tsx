import type { FileRecord } from '@nix/api-client';
import { Button, Tag, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { fileKindLabel, formatBytes, formatWhen } from '../collections/items/file-facts';

/**
 * The facts about a file, and its versions: the drawer beside the content.
 *
 * Everything the old file page put above the fold and in the way. It is still all here, one
 * click away, because a checksum and a version list are what somebody verifying a download
 * needs - they are just not what somebody opening a file needs first.
 */
export function FileDetails({
  record,
  downloading,
  onDownloadVersion,
}: {
  readonly record: FileRecord;
  readonly downloading: boolean;
  readonly onDownloadVersion: (versionId: string) => void;
}): ReactNode {
  const file = record.current;
  const dimensions =
    file.pixelWidth !== null && file.pixelHeight !== null
      ? `${String(file.pixelWidth)} × ${String(file.pixelHeight)} px`
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section aria-labelledby="file-facts-heading" className="flex flex-col gap-2">
        <Text id="file-facts-heading" variant="h6" as="h3" tone="muted">
          Details
        </Text>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
          <Fact label="Name">{file.fileName}</Fact>
          <Fact label="Type">
            {fileKindLabel(file.fileName, file.mediaType)}
            <Text as="span" variant="caption" tone="muted" className="ml-2 break-all">
              {file.mediaType}
            </Text>
          </Fact>
          <Fact label="Size">{formatBytes(file.byteLength)}</Fact>
          {dimensions === null ? null : <Fact label="Dimensions">{dimensions}</Fact>}
          <Fact label="Added">{formatWhen(file.createdAt)}</Fact>
          <Fact label="SHA-256">
            <span className="font-mono break-all">{file.sha256}</span>
          </Fact>
        </dl>
      </section>

      <section aria-labelledby="file-versions-heading" className="flex flex-col gap-2">
        <Text id="file-versions-heading" variant="h6" as="h3" tone="muted">
          Versions
        </Text>
        <ul className="flex flex-col gap-2">
          {[...record.versions]
            .sort((a, b) => b.version - a.version)
            .map((version) => (
              <li
                key={version.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-2">
                    <Text as="span" variant="bodySmall">
                      Version {String(version.version)}
                    </Text>
                    {version.current ? <Tag tone="accent">Current</Tag> : null}
                  </span>
                  <Text as="span" variant="caption" tone="muted">
                    {formatWhen(version.createdAt)} · {formatBytes(version.byteLength)}
                  </Text>
                </div>
                <Button
                  variant="ghost"
                  disabled={downloading}
                  aria-label={`Download version ${String(version.version)}`}
                  onClick={() => {
                    onDownloadVersion(version.id);
                  }}
                >
                  Download
                </Button>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <>
      <Text as="dt" variant="caption" tone="muted" className="pt-0.5">
        {label}
      </Text>
      <Text as="dd" variant="bodySmall" className="min-w-0 break-all">
        {children}
      </Text>
    </>
  );
}
