import { Blueprint, Button, Dialog, Icon, Tag, Text, focusRing } from '@nix/ui';
import { ArrowLeft, FileCheck2, FileUp, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { isCanceledError, isNixApiError, NixErrorKind } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { useTemplateLibrary } from '../template-library-context';
import {
  beginAndPreviewTemplate,
  cancelTemplateImport,
  commitAndWaitTemplate,
  type TemplateImportPreview,
} from '../template-api';
import {
  forgetDraft,
  identify,
  isSameFile,
  readDraft,
  writeDraft,
  type FileIdentity,
} from './import-draft';
import { templateFailure } from '../use-templates';
import { useWorkspace } from '../../workspaces/workspace-context';

export function TemplateImportPage(): ReactNode {
  const zen = useZenActive();
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const templateLibrary = useTemplateLibrary();
  const templateCapabilities = templateLibrary.capabilities;
  const templateStatus = templateLibrary.status;
  const [recovered] = useState(() => readDraft(workspaceId));
  const [file, setFile] = useState<File | null>(null);
  const [importId, setImportId] = useState<string | null>(recovered.importId);
  const [preview, setPreview] = useState<TemplateImportPreview | null>(recovered.preview);
  const [idempotencyKey, setIdempotencyKey] = useState(recovered.idempotencyKey);
  const [previewFileIdentity, setPreviewFileIdentity] = useState<FileIdentity | null>(
    recovered.fileIdentity,
  );
  const [commitRequiresDiscard, setCommitRequiresDiscard] = useState(false);
  const [activity, setActivity] = useState<
    'idle' | 'validating' | 'importing' | 'replacing' | 'discarding'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const activeImportId = useRef<string | null>(recovered.importId);
  const previewHeading = useRef<HTMLDivElement | null>(null);
  const working = activity !== 'idle';

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (file === null && preview === null && importId === null && previewFileIdentity === null)
      return;
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, [file, importId, preview, previewFileIdentity]);

  useEffect(() => {
    if (preview !== null) previewHeading.current?.focus();
  }, [preview]);

  function choose(event: ChangeEvent<HTMLInputElement>): void {
    const selected = event.target.files?.[0] ?? null;
    const keepsRecoveredAttempt =
      selected !== null &&
      previewFileIdentity !== null &&
      isSameFile(selected, previewFileIdentity);
    if (keepsRecoveredAttempt) {
      setFile(selected);
      setError(null);
      writeDraft(workspaceId, {
        importId,
        preview,
        idempotencyKey,
        fileIdentity: identify(selected),
      });
      return;
    }
    void replaceSelection(selected, event.currentTarget);
  }

  async function replaceSelection(selected: File | null, input: HTMLInputElement): Promise<void> {
    const request = activeRequest.current;
    request?.abort();
    if (activeRequest.current === request) activeRequest.current = null;
    const previousImportId = activeImportId.current;
    setError(null);
    if (previousImportId !== null) {
      setActivity('replacing');
      try {
        await cancelTemplateImport(client, previousImportId);
      } catch (reason) {
        // Let the same replacement be chosen again. React still owns the previous archive state.
        input.value = '';
        setError(
          `${templateFailure(reason, 'The previous template import could not be released.')} It remains available to retry or discard.`,
        );
        setActivity('idle');
        return;
      }
      setActivity('idle');
    }

    setFile(selected);
    setPreview(null);
    setCommitRequiresDiscard(false);
    setPreviewFileIdentity(null);
    const nextIdempotencyKey = globalThis.crypto.randomUUID();
    setIdempotencyKey(nextIdempotencyKey);
    setImportId(null);
    activeImportId.current = null;
    if (selected === null) {
      forgetDraft(workspaceId);
      return;
    }
    const fileIdentity = identify(selected);
    setPreviewFileIdentity(fileIdentity);
    writeDraft(workspaceId, {
      importId: null,
      preview: null,
      idempotencyKey: nextIdempotencyKey,
      fileIdentity,
    });
  }

  async function validate(): Promise<void> {
    if (file === null) {
      setError('Choose a .nix template file first.');
      return;
    }
    setActivity('validating');
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const fileIdentity = identify(file);
    setPreviewFileIdentity(fileIdentity);
    writeDraft(workspaceId, {
      importId,
      preview,
      idempotencyKey,
      fileIdentity,
    });
    try {
      const result = await beginAndPreviewTemplate(
        client,
        {
          workspaceId,
          fileName: file.name,
          mediaType: file.type || 'application/octet-stream',
          byteLength: file.size,
          idempotencyKey,
        },
        file,
        controller.signal,
        (startedImportId) => {
          activeImportId.current = startedImportId;
          setImportId(startedImportId);
          setPreviewFileIdentity(fileIdentity);
          writeDraft(workspaceId, {
            importId: startedImportId,
            preview: null,
            idempotencyKey,
            fileIdentity,
          });
        },
      );
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      if (result.preview === null) {
        throw new Error('The template preview did not become ready.');
      }
      activeImportId.current = result.id;
      setImportId(result.id);
      setPreview(result.preview);
      setCommitRequiresDiscard(false);
      setPreviewFileIdentity(fileIdentity);
      writeDraft(workspaceId, {
        importId: result.id,
        preview: result.preview,
        idempotencyKey,
        fileIdentity,
      });
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      const recovery =
        activeImportId.current === null
          ? 'The selected archive and retry identity remain in this tab, so you can safely try validation again.'
          : 'The same durable attempt is retained, so you can safely try validation again.';
      setError(
        `${templateFailure(reason, 'This template file could not be validated.')} ${recovery}`,
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setActivity('idle');
      }
    }
  }

  async function finish(): Promise<void> {
    if (preview === null || importId === null || commitRequiresDiscard) return;
    setActivity('importing');
    setError(null);
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      await commitAndWaitTemplate(client, importId, preview.digest, controller.signal);
      if (controller.signal.aborted || activeRequest.current !== controller) return;
      activeImportId.current = null;
      setImportId(null);
      forgetDraft(workspaceId);
      void navigate(`/w/${workspaceId}/templates`);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      if (
        isNixApiError(reason) &&
        (reason.code === 'template.file_changed' ||
          (reason.kind === NixErrorKind.Operation && reason.code.startsWith('template')))
      ) {
        setCommitRequiresDiscard(true);
        setError(
          `${reason.detail ?? 'The template import cannot continue.'} Discard this attempt before previewing the file again.`,
        );
        return;
      }
      setError(
        `${templateFailure(reason, 'This template could not be added to the library.')} This durable attempt is retained and can be retried safely.`,
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        setActivity('idle');
      }
    }
  }

  async function discard(): Promise<void> {
    const request = activeRequest.current;
    request?.abort();
    if (activeRequest.current === request) activeRequest.current = null;
    setActivity('discarding');
    setError(null);
    const currentImportId = activeImportId.current;
    try {
      if (currentImportId !== null) await cancelTemplateImport(client, currentImportId);
      activeImportId.current = null;
      setImportId(null);
      forgetDraft(workspaceId);
      void navigate(`/w/${workspaceId}/templates`);
    } catch (reason) {
      setDiscarding(false);
      setError(templateFailure(reason, 'This staged template import could not be discarded.'));
      setActivity('idle');
    }
  }

  if (templateStatus === 'loading') {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-3 sm:p-5">
        <Text tone="muted">Checking template access…</Text>
      </div>
    );
  }

  if (templateStatus === 'error') {
    return (
      <ImportNotice
        title="Template library unavailable"
        detail={
          templateLibrary.error ?? 'The template library could not be loaded. Check the connection.'
        }
      >
        <Button variant="secondary" onClick={templateLibrary.reload}>
          Try again
        </Button>
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </ImportNotice>
    );
  }

  if (!templateCapabilities.canManage) {
    return (
      <ImportNotice
        title="Template import unavailable"
        detail="You can browse and download workspace templates, but you cannot add or change them."
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </ImportNotice>
    );
  }

  const canAdd = !working && importId !== null && preview !== null && !commitRequiresDiscard;

  return (
    <div className="@container/import flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className={`flex min-w-0 shrink-0 items-center gap-2 border-b border-divider px-3 py-2 ${zen ? 'pr-16' : ''}`}
      >
        <Button
          variant="icon"
          aria-label="Cancel template import"
          onClick={() => {
            setDiscarding(true);
          }}
        >
          <Icon icon={ArrowLeft} size="sm" />
        </Button>
        <Text variant="h4" as="h1">
          Import template
        </Text>
      </header>

      <section
        aria-label="Template import"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5"
      >
        <div className="mx-auto grid min-w-0 max-w-5xl gap-3 @4xl/import:grid-cols-2">
          <Blueprint className="flex min-w-0 flex-col items-start gap-3 p-3">
            <Icon icon={FileUp} size="md" />
            <label className="flex min-w-0 max-w-full flex-col gap-2">
              <Text variant="bodySmall" as="span">
                Template file
              </Text>
              <input
                type="file"
                accept=".nix,application/x-nix-template,application/zip"
                onChange={choose}
                disabled={working}
                aria-invalid={error === null ? undefined : true}
                aria-describedby={error === null ? undefined : 'template-import-error'}
                className={`min-h-(--control-md) min-w-0 max-w-full any-pointer-coarse:min-h-(--control-lg) ${focusRing}`}
              />
            </label>
            {file === null ? null : (
              <Text variant="caption" tone="muted">
                Selected: {file.name}
              </Text>
            )}
            {file === null && preview === null && previewFileIdentity !== null ? (
              <Text variant="bodySmall" role="status">
                A previous attempt for {previewFileIdentity.name} can be resumed. Select that same
                file again. Nix kept the retry details, but this browser did not retain the archive
                bytes.
              </Text>
            ) : null}
            {file === null &&
            preview === null &&
            importId !== null &&
            previewFileIdentity === null ? (
              <Text variant="bodySmall" role="status">
                A durable attempt is still recorded, but its local file details are unavailable.
                Discard it before choosing the archive again.
              </Text>
            ) : null}
            {activity === 'replacing' ? (
              <Text as="p" variant="caption" role="status" tone="muted">
                Releasing the previous staged import…
              </Text>
            ) : null}
            {error === null ? null : (
              <div id="template-import-error" className="flex flex-col items-start gap-2">
                <Text variant="bodySmall" role="alert">
                  {error}
                </Text>
                {commitRequiresDiscard ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setDiscarding(true);
                    }}
                  >
                    Discard attempt
                  </Button>
                ) : null}
              </div>
            )}
          </Blueprint>

          <section aria-label="Import preview" className="flex min-w-0 flex-col gap-3">
            {preview === null ? (
              <Blueprint className="p-3">
                <Text tone="muted">
                  Choose and validate a file to preview it. Nothing is imported until you add it.
                </Text>
              </Blueprint>
            ) : (
              <Blueprint className="flex flex-col gap-3 p-3">
                <div ref={previewHeading} tabIndex={-1} className={focusRing}>
                  <Icon icon={FileCheck2} size="md" />
                  <Text variant="h3">{preview.profile.name}</Text>
                  {preview.profile.description.length === 0 ? null : (
                    <Text variant="bodySmall" tone="muted">
                      {preview.profile.description}
                    </Text>
                  )}
                  <Text as="p" variant="caption" role="status" aria-live="polite" tone="muted">
                    Validation complete. Review this preview before adding it to the library.
                  </Text>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <ImportCount label="Items" value={preview.itemCount} />
                  <ImportCount label="Bodies" value={preview.bodyCount} />
                  <ImportCount label="Views" value={preview.viewCount} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {preview.profile.includeBody ? <Tag tone="muted">Content</Tag> : null}
                  {preview.profile.includeChildren ? <Tag tone="muted">Children</Tag> : null}
                  <Tag>{preview.rootItemType}</Tag>
                </div>
                {file === null ? (
                  <Text variant="bodySmall" role="status">
                    This recovered preview is ready because Nix retained the uploaded archive for
                    this durable attempt. This browser stored recovery details, not local file
                    bytes.
                  </Text>
                ) : null}
              </Blueprint>
            )}
          </section>
        </div>
      </section>

      <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-divider bg-background px-3 py-2">
        <Button
          variant={preview === null ? 'primary' : 'secondary'}
          disabled={working || file === null || preview !== null}
          onClick={() => void validate()}
        >
          <Icon icon={ShieldCheck} size="sm" />{' '}
          {activity === 'validating' ? 'Validating…' : 'Validate file'}
        </Button>
        <Button disabled={!canAdd} onClick={() => void finish()}>
          {activity === 'importing' ? 'Importing…' : 'Add to library'}
        </Button>
      </footer>

      <Dialog
        open={discarding}
        title="Discard this import?"
        onClose={() => {
          if (activity !== 'discarding') setDiscarding(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={activity === 'discarding'}
              onClick={() => {
                setDiscarding(false);
              }}
            >
              Keep reviewing
            </Button>
            <Button disabled={activity === 'discarding'} onClick={() => void discard()}>
              {activity === 'discarding' ? 'Discarding…' : 'Discard import'}
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          The staged import and the local recovery details will be removed.
        </Text>
      </Dialog>
    </div>
  );
}

/** A full-pane notice for the states where the import form cannot be shown. */
function ImportNotice({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-3 sm:p-5">
      <Blueprint className="flex min-w-0 max-w-lg flex-col items-start gap-3 p-3 sm:p-5">
        <Icon icon={ShieldCheck} size="md" />
        <Text variant="h3" as="h1">
          {title}
        </Text>
        <Text tone="muted">{detail}</Text>
        {children === undefined ? null : <div className="flex flex-wrap gap-2">{children}</div>}
      </Blueprint>
    </div>
  );
}

function ImportCount({
  label,
  value,
}: {
  readonly label: string;
  readonly value: number;
}): ReactNode {
  return (
    <div className="rounded-md bg-surface p-2 text-center">
      <Text variant="h3">{String(value)}</Text>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
    </div>
  );
}
