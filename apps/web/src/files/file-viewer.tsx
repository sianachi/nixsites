import { files as fileResources, isNixApiError, type FileRecord } from '@nix/api-client';
import { Button, ContextMenu, Dialog, Icon, Text, cn } from '@nix/ui';
import { Download, File as FileIcon, Info, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  cacheKeysOverlap,
  useCacheInvalidation,
} from '@nix/web-platform/api/use-cache-invalidation';
import { useOverlayDetails } from '@nix/web-foundation/layout/viewport';
import { findBuiltInFileViewer } from '../plugins/built-in-file-viewers';
import { FileDetails } from './file-details';
import { fileKindLabel, formatBytes } from './file-facts';
import { quietTopControl, useNearTopEdge } from '@nix/web-foundation/lib/use-near-top-edge';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';

/**
 * The file page: the file, first.
 *
 * **What changed and why.** This page used to be a scrolling column: preview, then a definition
 * list of name, type, size and checksum, then buttons, then the version list, all at the same
 * weight. Somebody opening a PDF got seventy percent of a viewport of PDF and then a form. A file
 * page in the products this one is replacing is the file edge to edge, with a thin bar naming it
 * and a drawer for the facts - so that is the shape now. The stage fills the pane; the toolbar is
 * one line; the details and versions are behind one button, in a drawer beside the stage on a
 * wide window and in a dialog on a narrow one.
 *
 * **What a stage draws.** A viewer plugin when one claims the file (text, code, CSV, Markdown,
 * Mermaid, audio, video - `built-in-file-viewers.ts`), else the browser's PDF viewer, else an
 * image, else a placard that names the file and offers the download. Plugins that want the bytes
 * as text get text; plugins that want a URL get the object URL; PDF and image are the two the
 * host draws itself because they need no code at all.
 *
 * **What has not changed.** The bytes come from the authorised download capability and nowhere
 * else, previews are fetched only for files the server marked previewable or a plugin claimed,
 * and the download stays available when the preview is refused.
 */

interface Preview {
  readonly versionId: string;
  readonly url: string | null;
  readonly source: string | null;
  /** Set alongside `url`, for a viewer that reads the bytes itself. */
  readonly blob?: Blob;
  readonly failed: boolean;
}

export function FileViewer({
  itemId,
  itemControls,
}: {
  readonly itemId: string;
  /** The item's own controls - details and actions - when they live in this bar on a phone. */
  readonly itemControls?: ReactNode;
}): ReactNode {
  const client = useApiClient();
  const overlayDetails = useOverlayDetails();
  const zen = useZenActive();
  const nearTop = useNearTopEdge();
  const [record, setRecord] = useState<FileRecord | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ readonly itemId: string; readonly message: string } | null>(
    null,
  );
  const [replacing, setReplacing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const replacementRef = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState(0);
  useCacheInvalidation(
    (prefix) => cacheKeysOverlap(prefix, ['files', itemId]),
    () => {
      setRevision((current) => current + 1);
    },
  );

  const visibleRecord = record?.itemId === itemId ? record : null;
  const visibleError = error?.itemId === itemId ? error.message : null;
  const currentVersionId = visibleRecord?.current.id;
  const currentPreviewable = visibleRecord?.current.previewable ?? false;
  const currentMediaType = visibleRecord?.current.mediaType ?? '';
  const currentFileName = visibleRecord?.current.fileName ?? '';
  const currentViewer =
    visibleRecord === null
      ? null
      : findBuiltInFileViewer({ fileName: currentFileName, mediaType: currentMediaType });
  const viewerWantsText = currentViewer !== null && (currentViewer.source ?? 'text') === 'text';
  // A streaming viewer (audio) fetches its own address and the host holds no bytes for it.
  const viewerStreams = currentViewer?.source === 'stream';

  useEffect(() => {
    const controller = new AbortController();
    void client
      .query(fileResources.fileByItem(itemId), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((next) => {
        if (!controller.signal.aborted) {
          setRecord(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          if (
            isNixApiError(reason) &&
            (reason.status === 403 || reason.status === 404 || reason.status === 423)
          ) {
            setRecord(null);
            setPreview(null);
          }
          setError({
            itemId,
            message: isNixApiError(reason)
              ? (reason.detail ?? 'The file metadata is unavailable.')
              : 'The file metadata is unavailable.',
          });
        }
      });
    return () => {
      controller.abort();
    };
  }, [client, itemId, revision]);

  useEffect(() => {
    if ((!currentPreviewable && currentViewer === null) || currentVersionId === undefined) return;
    if (viewerStreams) return;
    const versionId = currentVersionId;
    const controller = new AbortController();
    let url: string | null = null;
    void fileResources
      .fetchFileContent(client, itemId, undefined, true, controller.signal)
      .then(async ({ blob }) => {
        if (viewerWantsText) {
          setPreview({ versionId, url: null, source: await blob.text(), failed: false });
          return;
        }
        url = URL.createObjectURL(blob);
        setPreview({ versionId, url, source: null, blob, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setPreview({ versionId, url: null, source: null, failed: true });
      });
    return () => {
      controller.abort();
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [
    client,
    currentPreviewable,
    currentVersionId,
    currentViewer,
    itemId,
    viewerStreams,
    viewerWantsText,
  ]);

  const currentPreview = preview?.versionId === currentVersionId ? preview : null;

  async function download(versionId?: string): Promise<void> {
    setDownloading(true);
    setError(null);
    try {
      const { blob } = await fileResources.fetchFileContent(client, itemId, versionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        versionId === undefined
          ? (visibleRecord?.current.fileName ?? 'download')
          : (visibleRecord?.versions.find((version) => version.id === versionId)?.fileName ??
            'download');
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError({ itemId, message: refusal(reason, 'The download was refused.') });
    } finally {
      setDownloading(false);
    }
  }

  async function replace(file: File): Promise<void> {
    if (visibleRecord === null) return;
    setReplacing(true);
    setError(null);
    try {
      const upload = await client.execute(
        fileResources.beginUpload({
          workspaceId: visibleRecord.workspaceId,
          parentId: null,
          targetItemId: itemId,
          fileName: file.name,
          mediaType: file.type || 'application/octet-stream',
          byteLength: file.size,
          idempotencyKey: `web-file-replace:${crypto.randomUUID()}`,
        }),
      );
      const updated = await fileResources.uploadAndCompleteFile(client, upload, file);
      setRecord(updated);
    } catch (reason) {
      setError({ itemId, message: refusal(reason, 'The replacement was refused.') });
    } finally {
      setReplacing(false);
    }
  }

  if (visibleRecord === null)
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Text variant="note" tone="muted" {...(visibleError === null ? {} : { role: 'alert' })}>
          {visibleError ?? 'Loading file metadata…'}
        </Text>
      </div>
    );

  const file = visibleRecord.current;
  const canPreview = file.previewable || currentViewer !== null;
  const details = (
    <FileDetails
      record={visibleRecord}
      downloading={downloading}
      onDownloadVersion={(versionId) => void download(versionId)}
    />
  );

  return (
    <section aria-label="File" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* In Zen the bar gives way to one quiet download beside the shell's exit control, and the
          stage below keeps its place in the tree, so a PDF keeps its page and audio keeps playing. */}
      {zen ? (
        <Button
          variant="icon"
          aria-label="Download"
          title="Download"
          disabled={downloading}
          onClick={() => void download()}
          // design-token-exempt: clears the exit control, which is one large control step wide.
          className={cn(
            'fixed right-[calc(var(--control-lg)+var(--spacing)*4)] top-[calc(env(safe-area-inset-top)+var(--spacing)*3)] z-20 bg-background',
            quietTopControl(nearTop),
          )}
        >
          <Icon icon={Download} size="sm" />
        </Button>
      ) : (
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-divider px-3 py-1.5 sm:px-8">
          {/* The bar: what the file is, and the three things done to a file. One line, the
              header's own gutter, so it reads as part of the page's chrome and not as content. */}
          <Icon icon={FileIcon} size="sm" />
          <Text as="span" variant="bodySmall" className="min-w-0 flex-1 truncate font-semibold">
            {file.fileName}
          </Text>
          <Text
            as="span"
            variant="caption"
            tone="muted"
            className="hidden whitespace-nowrap sm:inline"
          >
            {fileKindLabel(file.fileName, file.mediaType)} · {formatBytes(file.byteLength)}
          </Text>
          <Button
            variant="ghost"
            className="shrink-0"
            aria-label={downloading ? 'Downloading…' : 'Download'}
            disabled={downloading}
            onClick={() => void download()}
          >
            <Icon icon={Download} size="sm" />
            <span className="sr-only sm:not-sr-only">
              {downloading ? 'Downloading…' : 'Download'}
            </span>
          </Button>
          <Button
            variant="ghost"
            className="shrink-0"
            aria-label={replacing ? 'Replacing…' : 'Replace file'}
            disabled={replacing}
            onClick={() => replacementRef.current?.click()}
          >
            <Icon icon={Upload} size="sm" />
            <span className="sr-only sm:not-sr-only">
              {replacing ? 'Replacing…' : 'Replace file'}
            </span>
          </Button>
          <Button
            variant="ghost"
            className="shrink-0"
            aria-label="File info"
            aria-expanded={detailsOpen}
            onClick={() => {
              setDetailsOpen(!detailsOpen);
            }}
          >
            <Icon icon={Info} size="sm" />
            {/* "File info", not "Details": the item's own Details - its fields and settings - can
              sit in this same bar on a phone, and two buttons with one name would be a guess. */}
            <span className="sr-only sm:not-sr-only">File info</span>
          </Button>
          {itemControls}
        </div>
      )}
      <input
        ref={replacementRef}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Choose replacement file"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (selected !== undefined) void replace(selected);
        }}
      />

      {visibleError === null ? null : (
        <Text variant="note" as="p" role="alert" className="shrink-0 px-5 py-1.5 sm:px-8">
          {visibleError}
        </Text>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
        {/* The stage. It owns the scrolling so a tall image or a long listing scrolls under the
            bar rather than pushing it away. */}
        <ContextMenu
          label="File actions"
          items={[
            {
              label: 'Download',
              icon: Download,
              disabled: downloading,
              onSelect: () => void download(),
            },
            {
              label: 'Replace file',
              icon: Upload,
              disabled: replacing,
              onSelect: () => {
                replacementRef.current?.click();
              },
            },
            {
              label: 'File info',
              icon: Info,
              onSelect: () => {
                setDetailsOpen(true);
              },
            },
          ]}
        >
          {(target) => (
            <div {...target} className="flex min-h-0 min-w-0 flex-1 flex-col">
              <Stage
                itemId={itemId}
                file={file}
                preview={currentPreview}
                viewer={currentViewer}
                canPreview={canPreview}
                downloading={downloading}
                onDownload={() => void download()}
              />
            </div>
          )}
        </ContextMenu>

        {detailsOpen && !overlayDetails && !zen ? (
          <aside
            aria-label="File details"
            className="w-80 shrink-0 overflow-y-auto border-l border-divider p-4"
          >
            {details}
          </aside>
        ) : null}
      </div>

      {detailsOpen && (overlayDetails || zen) ? (
        <Dialog
          open
          swipeToClose
          title="File details"
          onClose={() => {
            setDetailsOpen(false);
          }}
        >
          {details}
        </Dialog>
      ) : null}
    </section>
  );
}

function Stage({
  itemId,
  file,
  preview,
  viewer,
  canPreview,
  downloading,
  onDownload,
}: {
  readonly itemId: string;
  readonly file: FileRecord['current'];
  readonly preview: Preview | null;
  readonly viewer: ReturnType<typeof findBuiltInFileViewer>;
  readonly canPreview: boolean;
  readonly downloading: boolean;
  readonly onDownload: () => void;
}): ReactNode {
  if (!canPreview) {
    return (
      <Placard file={file} downloading={downloading} onDownload={onDownload}>
        No preview for this kind of file.
      </Placard>
    );
  }
  if (viewer?.source === 'stream') {
    const Viewer = viewer.Component;
    return (
      <Viewer
        key={file.id}
        itemId={itemId}
        fileName={file.fileName}
        source=""
        onDownload={onDownload}
      />
    );
  }
  if (preview === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Text variant="note" tone="muted" role="status">
          Loading the authorized preview…
        </Text>
      </div>
    );
  }
  if (preview.failed) {
    return (
      <Placard file={file} downloading={downloading} onDownload={onDownload} alert>
        The preview is unavailable. You can still download the file.
      </Placard>
    );
  }
  if (viewer !== null) {
    const Viewer = viewer.Component;
    const source = (viewer.source ?? 'text') === 'text' ? preview.source : preview.url;
    if (source !== null) {
      return (
        <Viewer
          key={file.id}
          itemId={itemId}
          fileName={file.fileName}
          source={source}
          {...(preview.blob === undefined ? {} : { blob: preview.blob })}
          onDownload={onDownload}
        />
      );
    }
  }
  if (preview.url !== null && file.mediaType === 'application/pdf') {
    return <iframe title={file.fileName} src={preview.url} className="h-full w-full flex-1" />;
  }
  if (preview.url !== null && file.mediaType.startsWith('image/')) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface p-4">
        <img
          src={preview.url}
          alt={file.fileName}
          className="max-h-full max-w-full rounded-md object-contain"
        />
      </div>
    );
  }
  return (
    <Placard file={file} downloading={downloading} onDownload={onDownload}>
      No preview for this kind of file.
    </Placard>
  );
}

/** The stage when there is nothing to draw: the file's name and kind, and its download. */
function Placard({
  file,
  downloading,
  onDownload,
  alert = false,
  children,
}: {
  readonly file: FileRecord['current'];
  readonly downloading: boolean;
  readonly onDownload: () => void;
  readonly alert?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4 text-center sm:p-8">
      <Icon icon={FileIcon} size="lg" />
      <Text variant="body" as="p" className="max-w-full break-all font-semibold">
        {file.fileName}
      </Text>
      <Text variant="note" tone="muted" as="p" {...(alert ? { role: 'alert' } : {})}>
        {children}
      </Text>
      <Button variant="secondary" disabled={downloading} onClick={onDownload}>
        {downloading ? 'Downloading…' : `Download ${formatBytes(file.byteLength)}`}
      </Button>
    </div>
  );
}

function refusal(reason: unknown, fallback: string): string {
  return isNixApiError(reason)
    ? (reason.detail ?? fallback)
    : reason instanceof Error
      ? reason.message
      : fallback;
}
