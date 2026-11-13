import { isCanceledError } from '@nix/api-client';
import { Button, Dialog, Field, Icon, Input, Text } from '@nix/ui';
import { FileUp, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { fileNameFrom, saveArchive } from '@nix/web-platform/export/export-archive';
import { useTemplateLibrary } from '../template-library-context';
import {
  beginAndPreviewTemplate,
  cancelTemplateImport,
  commitAndWaitTemplate,
  deleteTemplate,
  exportTemplate,
  type TemplateSummary,
} from '../template-api';
import { templateFailure } from '../use-templates';
import { TemplateCard } from './template-card';
import {
  builtInArchive,
  loadBuiltInTemplates,
  missingBuiltIns,
  type BuiltInTemplate,
} from './built-in-catalog';
import { BuiltInTemplateCard } from './built-in-template-card';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';

interface DuplicateAttempt {
  readonly idempotencyKey: string;
  readonly archive: Blob | null;
  readonly fileName: string | null;
  readonly importId: string | null;
  readonly digest: string | null;
}

export function TemplateLibraryPage(): ReactNode {
  const zen = useZenActive();
  const library = useTemplateLibrary();
  const client = useApiClient();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const { saved: petSettings } = usePetSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [failedDuplicate, setFailedDuplicate] = useState<TemplateSummary | null>(null);
  const [builtIns, setBuiltIns] = useState<readonly BuiltInTemplate[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const addAttempts = useRef(new Map<string, string>());
  useEffect(() => {
    let current = true;
    // Without them the library still works, so a failed fetch (offline, say) shows nothing.
    void loadBuiltInTemplates().then(
      (catalog) => {
        if (current) setBuiltIns(catalog);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);
  const duplicateAttempts = useRef(new Map<string, DuplicateAttempt>());
  const activeRequests = useRef(new Set<AbortController>());
  useEffect(() => {
    const pendingRequests = activeRequests.current;
    const attempts = duplicateAttempts.current;
    return () => {
      for (const controller of pendingRequests) controller.abort();
      pendingRequests.clear();
      for (const attempt of attempts.values()) {
        if (attempt.importId !== null) {
          void cancelTemplateImport(client, attempt.importId).catch(() => undefined);
        }
      }
      attempts.clear();
    };
  }, [client]);
  const query = searchParams.get('q') ?? '';
  const targetItemId = searchParams.get('target');
  const parentItemId = searchParams.get('parent');
  const normalized = query.trim().toLocaleLowerCase();
  const visible = library.templates.filter((template) =>
    normalized.length === 0
      ? true
      : `${template.title} ${template.description ?? ''} ${template.viewKinds.join(' ')}`
          .toLocaleLowerCase()
          .includes(normalized),
  );

  // Adding one imports its archive, which needs the right to manage this workspace's templates.
  const offered = library.capabilities.canManage
    ? missingBuiltIns(builtIns, library.templates).filter((template) =>
        normalized.length === 0
          ? true
          : `${template.name} ${template.description} ${template.viewKinds.join(' ')}`
              .toLocaleLowerCase()
              .includes(normalized),
      )
    : [];

  /** Imports a built-in into this workspace, then carries on as if it had always been there. */
  async function addBuiltIn(template: BuiltInTemplate): Promise<void> {
    setAdding(template.key);
    setAddError(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    // One key per built-in and workspace, so a retry resumes the same import.
    const attempt = `${workspaceId}:${template.key}`;
    const idempotencyKey = addAttempts.current.get(attempt) ?? globalThis.crypto.randomUUID();
    addAttempts.current.set(attempt, idempotencyKey);
    try {
      const archive = builtInArchive(template);
      const previewed = await beginAndPreviewTemplate(
        client,
        {
          workspaceId,
          fileName: `${template.key}.nix`,
          mediaType: archive.type,
          byteLength: archive.size,
          idempotencyKey,
        },
        archive,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (previewed.preview === null) throw new Error('The template preview did not become ready.');
      const imported = await commitAndWaitTemplate(
        client,
        previewed.id,
        previewed.preview.digest,
        controller.signal,
      );
      if (imported.result === null) throw new Error('The template import did not publish.');
      addAttempts.current.delete(attempt);
      library.reload();
      beginTemplate(imported.result.templateId);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setAddError(
        templateFailure(reason, `${template.name} could not be added to this workspace.`),
      );
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setAdding(null);
    }
  }

  function beginTemplate(templateId: string): void {
    if (targetItemId !== null) {
      void navigate(`/w/${workspaceId}/items/${targetItemId}/templates/apply/${templateId}`);
      return;
    }
    const suffix = parentItemId === null ? '' : `?parent=${encodeURIComponent(parentItemId)}`;
    void navigate(`/w/${workspaceId}/templates/${templateId}/create${suffix}`);
  }

  async function remove(): Promise<void> {
    if (deleting === null) return;
    setWorking(true);
    setDeleteError(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    try {
      await client.execute(deleteTemplate(deleting), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDeleting(null);
    } catch (error) {
      if (controller.signal.aborted || isCanceledError(error)) return;
      setDeleteError(templateFailure(error, 'This template could not be deleted.'));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setWorking(false);
    }
  }

  async function download(template: TemplateSummary): Promise<void> {
    setDownloading(template.id);
    setDownloadError(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    try {
      const result = await client.download(exportTemplate(template.id), {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      saveArchive({
        blob: result.blob,
        fileName: fileNameFrom(result.headers['content-disposition'] ?? null),
        itemCount: template.childCount + 1,
        omittedCount: 0,
      });
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setDownloadError(templateFailure(reason, 'This template could not be downloaded.'));
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setDownloading(null);
    }
  }

  async function duplicate(template: TemplateSummary): Promise<void> {
    setDuplicating(template.id);
    setDuplicateError(null);
    setFailedDuplicate(null);
    const controller = new AbortController();
    activeRequests.current.add(controller);
    let attempt = duplicateAttempts.current.get(template.id) ?? {
      idempotencyKey: globalThis.crypto.randomUUID(),
      archive: null,
      fileName: null,
      importId: null,
      digest: null,
    };
    duplicateAttempts.current.set(template.id, attempt);
    try {
      let archive = attempt.archive;
      if (archive === null) {
        const exported = await client.download(exportTemplate(template.id), {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        archive = exported.blob;
        attempt = {
          ...attempt,
          archive,
          fileName: fileNameFrom(exported.headers['content-disposition'] ?? null),
        };
        duplicateAttempts.current.set(template.id, attempt);
      }
      let importId = attempt.importId;
      let digest = attempt.digest;
      if (importId === null || digest === null) {
        const imported = await beginAndPreviewTemplate(
          client,
          {
            workspaceId,
            fileName: attempt.fileName ?? 'template.nix',
            mediaType: archive.type || 'application/octet-stream',
            byteLength: archive.size,
            idempotencyKey: attempt.idempotencyKey,
          },
          archive,
          controller.signal,
          (startedImportId) => {
            attempt = { ...attempt, importId: startedImportId };
            duplicateAttempts.current.set(template.id, attempt);
          },
        );
        if (controller.signal.aborted) return;
        if (imported.preview === null) {
          throw new Error('The template preview did not become ready.');
        }
        importId = imported.id;
        digest = imported.preview.digest;
        attempt = { ...attempt, importId, digest };
        duplicateAttempts.current.set(template.id, attempt);
      }

      const imported = await commitAndWaitTemplate(client, importId, digest, controller.signal);
      if (controller.signal.aborted) return;
      if (imported.result === null) {
        throw new Error('The template import did not publish.');
      }
      duplicateAttempts.current.delete(template.id);
      void navigate(`/w/${workspaceId}/templates/${imported.result.templateId}/edit`);
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setDuplicateError(templateFailure(reason, 'This template could not be duplicated.'));
      setFailedDuplicate(template);
    } finally {
      activeRequests.current.delete(controller);
      if (!controller.signal.aborted) setDuplicating(null);
    }
  }

  async function startSeparateDuplicate(template: TemplateSummary): Promise<void> {
    const previous = duplicateAttempts.current.get(template.id);
    if (previous?.importId !== null && previous?.importId !== undefined) {
      setDuplicating(template.id);
      setDuplicateError(null);
      const controller = new AbortController();
      activeRequests.current.add(controller);
      try {
        await cancelTemplateImport(client, previous.importId, controller.signal);
        if (controller.signal.aborted) return;
      } catch (reason) {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setDuplicateError(
          templateFailure(reason, 'The previous duplicate could not be discarded.'),
        );
        setFailedDuplicate(template);
        return;
      } finally {
        activeRequests.current.delete(controller);
        if (!controller.signal.aborted) setDuplicating(null);
      }
    }

    duplicateAttempts.current.delete(template.id);
    await duplicate(template);
  }

  return (
    <div className="@container/library min-h-0 min-w-0 flex-1 overflow-y-auto bg-background p-3 sm:p-5">
      <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-4">
        <header
          className={`flex min-w-0 flex-col gap-3 @3xl/library:flex-row @3xl/library:items-end @3xl/library:justify-between ${zen ? 'pr-16' : ''}`}
        >
          <div className="flex min-w-0 max-w-2xl flex-col gap-1">
            <Text variant="h3" as="h1">
              Templates
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            {petSettings?.settings.enabled ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void navigate(`/w/${workspaceId}?pet=design`);
                }}
              >
                Design one with your pet
              </Button>
            ) : null}
            {library.capabilities.canManage ? (
              <Button
                variant="secondary"
                onClick={() => {
                  void navigate(`/w/${workspaceId}/templates/import`);
                }}
              >
                <Icon icon={FileUp} size="sm" /> Import template
              </Button>
            ) : null}
          </div>
        </header>

        <Field label="Search templates">
          {(control) => (
            <Input
              {...control}
              type="search"
              value={query}
              placeholder="Name, description, or view"
              onChange={(event) => {
                const next = new URLSearchParams(searchParams);
                if (event.target.value.length === 0) next.delete('q');
                else next.set('q', event.target.value);
                setSearchParams(next, { replace: true });
              }}
            />
          )}
        </Field>
        {downloadError === null ? null : (
          <Text variant="bodySmall" role="alert" className="rounded-md bg-surface px-3 py-2">
            {downloadError}
          </Text>
        )}
        {addError === null ? null : (
          <Text variant="bodySmall" role="alert" className="rounded-md bg-surface px-3 py-2">
            {addError}
          </Text>
        )}
        {duplicateError === null ? null : (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-md bg-surface px-3 py-2"
          >
            <Text variant="bodySmall" className="flex-1">
              {duplicateError} Retrying Duplicate will safely continue the same attempt.
            </Text>
            {failedDuplicate === null ? null : (
              <Button
                variant="secondary"
                onClick={() => {
                  const template = failedDuplicate;
                  void startSeparateDuplicate(template);
                }}
              >
                Start a separate duplicate
              </Button>
            )}
          </div>
        )}

        {library.status === 'loading' ? (
          <LoadingPanel label="templates" />
        ) : library.status === 'error' ? (
          <ErrorPanel
            title="Templates could not be loaded"
            detail={library.error ?? ''}
            action={
              <Button variant="secondary" onClick={library.reload}>
                <Icon icon={RefreshCw} size="sm" /> Try again
              </Button>
            }
          />
        ) : library.templates.length === 0 && offered.length === 0 && normalized.length === 0 ? (
          <EmptyPanel
            title="No templates yet"
            detail={
              library.capabilities.canManage
                ? 'Open an item and choose Save as template to add the first one.'
                : 'There are no templates available in this workspace.'
            }
          />
        ) : visible.length === 0 && offered.length === 0 ? (
          <EmptyPanel
            title="No templates match"
            detail="Try a different name, description, or view type."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('q');
                  setSearchParams(next, { replace: true });
                }}
              >
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="grid min-w-0 gap-3 @3xl/library:grid-cols-2 @6xl/library:grid-cols-3">
            {visible.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onUse={() => {
                  beginTemplate(template.id);
                }}
                onEdit={() => {
                  void navigate(`/templates/${template.id}/edit`);
                }}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleting(template);
                }}
                onDownload={() => {
                  void download(template);
                }}
                onDuplicate={() => {
                  void duplicate(template);
                }}
                downloading={downloading === template.id}
                duplicating={duplicating === template.id}
                duplicateDisabled={duplicating !== null}
                canDuplicate={
                  library.capabilities.canManage &&
                  template.origin !== 'user' &&
                  template.capabilities.canExport
                }
              />
            ))}
            {offered.map((template) => (
              <BuiltInTemplateCard
                key={template.key}
                template={template}
                adding={adding === template.key}
                disabled={adding !== null}
                onUse={() => {
                  void addBuiltIn(template);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={deleting !== null}
        title="Delete this template?"
        onClose={() => {
          if (!working) setDeleting(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              disabled={working}
              onClick={() => {
                setDeleting(null);
              }}
            >
              Keep template
            </Button>
            <Button disabled={working} onClick={() => void remove()}>
              {working ? 'Deleting…' : 'Delete template'}
            </Button>
          </>
        }
      >
        <Text variant="bodySmall">
          Existing items created from {deleting?.title ?? 'this template'} will not change.
        </Text>
        {deleteError === null ? null : (
          <Text variant="bodySmall" role="alert">
            {deleteError}
          </Text>
        )}
      </Dialog>
    </div>
  );
}
