import { exports as exportResources, isNixApiError, type Export } from '@nix/api-client';
import { Button, Dialog, Field, Segmented, Select, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import {
  cancelArchive,
  requestArchive,
  saveArchive,
  type ArchiveScope,
  type ArchiveResult,
} from './export-archive';
import {
  formatFor,
  formatPreamble,
  preferredFormat,
  type ExportFormat,
  type FormatDescriptor,
} from './export-formats';

const SCOPES: readonly { value: ArchiveScope; label: string }[] = [
  { value: 'item', label: 'This item' },
  { value: 'subtree', label: 'With everything inside' },
];

type FormatState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'empty' }
  | { readonly phase: 'failed'; readonly error: string }
  | { readonly phase: 'ready'; readonly formats: readonly FormatDescriptor[] };

type Progress =
  | { readonly phase: 'idle' }
  | { readonly phase: 'completed'; readonly result: ArchiveResult }
  | { readonly phase: 'queued' }
  | { readonly phase: 'running' }
  | { readonly phase: 'cancelling' }
  | { readonly phase: 'cancelled' }
  | { readonly phase: 'failed'; readonly error: string };

interface ActiveExport {
  readonly controller: AbortController;
  exportId: string | null;
  cancelling: boolean;
}

export interface ExportDialogProps {
  readonly open: boolean;
  readonly itemId: string;
  readonly hasChildren: boolean;
  readonly onClose: () => void;
}

export function ExportDialog({ open, itemId, hasChildren, onClose }: ExportDialogProps): ReactNode {
  const client = useApiClient();
  const [formatState, setFormatState] = useState<FormatState>({ phase: 'loading' });
  const [format, setFormat] = useState<ExportFormat | null>(null);
  const [formatAttempt, setFormatAttempt] = useState(0);
  const [scope, setScope] = useState<ArchiveScope>(hasChildren ? 'subtree' : 'item');
  const [progress, setProgress] = useState<Progress>({ phase: 'idle' });
  const active = useRef<ActiveExport | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void client
      .query(exportResources.formats(), {
        signal: controller.signal,
        forceRefresh: true,
      })
      .then((catalog) => {
        if (controller.signal.aborted) return;
        if (catalog.formats.length === 0) {
          setFormat(null);
          setFormatState({ phase: 'empty' });
          return;
        }
        setFormat((current) =>
          current !== null && formatFor(catalog.formats, current) !== undefined
            ? current
            : (preferredFormat(catalog.formats)?.format ?? null),
        );
        setFormatState({ phase: 'ready', formats: catalog.formats });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setFormatState({
          phase: 'failed',
          error: isNixApiError(reason)
            ? (reason.detail ?? 'The export formats are unavailable.')
            : 'The export formats are unavailable. Check your connection and try again.',
        });
      });
    return () => {
      controller.abort();
    };
  }, [client, formatAttempt, open]);

  useEffect(() => {
    const activeRequest = active;
    return () => {
      const current = activeRequest.current;
      current?.controller.abort();
      if (current?.exportId !== null && current?.exportId !== undefined && !current.cancelling) {
        void cancelArchive(client, current.exportId).catch(() => undefined);
      }
      activeRequest.current = null;
    };
  }, [client]);

  const formats = formatState.phase === 'ready' ? formatState.formats : [];
  const selectedFormat = format === null ? undefined : formatFor(formats, format);
  const working =
    progress.phase === 'queued' || progress.phase === 'running' || progress.phase === 'cancelling';

  function updateProgress(state: Export, request: ActiveExport): void {
    if (active.current !== request || request.controller.signal.aborted) return;
    if (state.cancellationRequested) {
      setProgress({ phase: 'cancelling' });
    } else if (state.status === 'running') {
      setProgress({ phase: 'running' });
    } else if (state.status === 'queued') {
      setProgress({ phase: 'queued' });
    }
  }

  async function run(): Promise<void> {
    if (selectedFormat === undefined || working) return;

    active.current?.controller.abort();
    const request: ActiveExport = {
      controller: new AbortController(),
      exportId: null,
      cancelling: false,
    };
    active.current = request;
    setProgress({ phase: 'queued' });

    const outcome = await requestArchive({
      client,
      itemId,
      scope,
      format: selectedFormat.format,
      signal: request.controller.signal,
      onStarted: (state) => {
        request.exportId = state.id;
        updateProgress(state, request);
      },
      onProgress: (state) => {
        updateProgress(state, request);
      },
    });

    if (request.controller.signal.aborted || active.current !== request) return;
    active.current = null;

    if (!outcome.ok) {
      setProgress(
        outcome.cancelled ? { phase: 'cancelled' } : { phase: 'failed', error: outcome.error },
      );
      return;
    }

    saveArchive(outcome.value);
    if (
      outcome.value.loss.length > 0 ||
      outcome.value.omittedCount > 0 ||
      outcome.value.omissions.length > 0
    ) {
      setProgress({ phase: 'completed', result: outcome.value });
    } else {
      setProgress({ phase: 'idle' });
      onClose();
    }
  }

  async function cancelCurrent(closeAfter = false): Promise<void> {
    const request = active.current;
    if (request === null) {
      if (closeAfter) onClose();
      return;
    }
    if (request.cancelling) return;

    request.cancelling = true;
    request.controller.abort(new DOMException('cancelled', 'AbortError'));
    setProgress({ phase: 'cancelling' });
    if (request.exportId === null) {
      active.current = null;
      if (closeAfter) onClose();
      else setProgress({ phase: 'cancelled' });
      return;
    }

    try {
      await cancelArchive(client, request.exportId);
      if (active.current !== request) return;
      active.current = null;
      if (closeAfter) onClose();
      else setProgress({ phase: 'cancelled' });
    } catch (reason) {
      if (active.current !== request) return;
      active.current = null;
      setProgress({
        phase: 'failed',
        error: isNixApiError(reason)
          ? (reason.detail ?? 'The export could not be cancelled.')
          : 'The export could not be cancelled. It may still finish in the background.',
      });
    }
  }

  function requestClose(): void {
    if (working) {
      void cancelCurrent(true);
      return;
    }
    onClose();
  }

  function retryFormats(): void {
    setFormatState({ phase: 'loading' });
    setFormatAttempt((current) => current + 1);
  }

  const progressLabel =
    progress.phase === 'queued'
      ? 'Waiting for an export worker…'
      : progress.phase === 'running'
        ? 'Preparing the download…'
        : progress.phase === 'cancelling'
          ? 'Cancelling the export…'
          : null;

  return (
    <Dialog
      open={open}
      title="Export"
      onClose={requestClose}
      closeLabel={working ? 'Cancel export' : 'Close'}
      actions={
        <>
          <Button
            variant="secondary"
            disabled={progress.phase === 'cancelling'}
            onClick={() => {
              if (working) void cancelCurrent();
              else onClose();
            }}
          >
            {working
              ? progress.phase === 'cancelling'
                ? 'Cancelling…'
                : 'Cancel export'
              : 'Close'}
          </Button>
          <Button
            onClick={() => {
              void run();
            }}
            disabled={working || selectedFormat === undefined}
          >
            {working ? 'Exporting…' : 'Export'}
          </Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-4 break-words">
        {formatState.phase === 'loading' ? (
          <div role="status" aria-busy="true">
            <Text tone="muted">Loading available export formats…</Text>
          </div>
        ) : null}

        {formatState.phase === 'empty' ? (
          <div role="status" className="flex flex-col items-start gap-2">
            <Text tone="muted">
              No export worker is currently advertising a format. Start the export worker, then try
              again.
            </Text>
            <Button variant="secondary" onClick={retryFormats}>
              Check again
            </Button>
          </div>
        ) : null}

        {formatState.phase === 'failed' ? (
          <div role="alert" className="flex flex-col items-start gap-2">
            <Text tone="muted">{formatState.error}</Text>
            <Button variant="secondary" onClick={retryFormats}>
              Try again
            </Button>
          </div>
        ) : null}

        {selectedFormat === undefined ? null : (
          <fieldset disabled={working} className="flex min-w-0 flex-col gap-4">
            <Field label="Format" hint={formatPreamble(selectedFormat)}>
              {(control) => (
                <Select
                  {...control}
                  value={selectedFormat.format}
                  disabled={working}
                  onChange={(event) => {
                    setFormat(event.target.value);
                    setProgress({ phase: 'idle' });
                  }}
                >
                  {formats.map((candidate) => (
                    <option key={candidate.format} value={candidate.format}>
                      {candidate.label} (.{candidate.extension})
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            {selectedFormat.declaredLoss.length > 0 ? (
              <div className="flex flex-col gap-2" aria-label="Export limitations">
                {selectedFormat.declaredLoss.map((detail) => (
                  <Text key={detail} variant="note" tone="muted">
                    {detail}
                  </Text>
                ))}
              </div>
            ) : null}
            {hasChildren ? (
              <Segmented
                label="What to export"
                options={SCOPES}
                value={scope}
                onChange={(value) => {
                  setScope(value);
                  setProgress({ phase: 'idle' });
                }}
              />
            ) : null}
          </fieldset>
        )}

        {progressLabel === null ? null : (
          <div role="status" aria-busy="true">
            <Text tone="muted">{progressLabel}</Text>
          </div>
        )}

        {progress.phase === 'cancelled' ? (
          <div role="status">
            <Text tone="muted">The export was cancelled. No download was started.</Text>
          </div>
        ) : null}

        {progress.phase === 'completed' ? (
          <div role="status" className="flex flex-col gap-2">
            <Text variant="note">
              {progress.result.itemCount} items were exported. {progress.result.omittedCount} items
              were omitted.
            </Text>
            {[...progress.result.loss, ...progress.result.omissions].map((detail, index) => (
              <Text key={`${String(index)}:${detail}`} variant="note" tone="muted">
                {detail}
              </Text>
            ))}
          </div>
        ) : null}
        {progress.phase === 'failed' ? (
          <div role="alert">
            <Text tone="muted">{progress.error}</Text>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
