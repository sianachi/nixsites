import { useEffect, type Dispatch, type SetStateAction } from 'react';

import { isCanceledError, isNixApiError, type NixClient } from '@nix/api-client';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import {
  beginTemplateEditDraft,
  resumeTemplateFileTransfer,
  templateById,
  templateEditDraftById,
  type TemplateDetail,
  type TemplateEditDraft,
} from '../template-api';
import {
  authoredRootTitle,
  newDraft,
  type StudioMode,
  type TemplateDraft,
} from '../template-studio-model';
import { templateFailure } from '../use-templates';

export interface TemplateStudioLoad {
  readonly client: NixClient;
  readonly mode: StudioMode;
  readonly templateId: string | undefined;
  readonly key: string;
  readonly scope: string;
  readonly loadVersion: number;
  readonly recoveredDraft: boolean;
  readonly initialDraft: TemplateDraft;
  readonly resumeOperationId: string | null;
  readonly editAttemptKey: string;
  readonly setTemplate: Dispatch<SetStateAction<TemplateDetail | null>>;
  readonly setEditOperation: Dispatch<SetStateAction<TemplateEditDraft | null>>;
  readonly setStaleEditDraft: Dispatch<SetStateAction<boolean>>;
  readonly setEditConflict: Dispatch<SetStateAction<string | null>>;
  readonly setLoading: Dispatch<SetStateAction<boolean>>;
  readonly setCopyingFiles: Dispatch<SetStateAction<boolean>>;
  readonly setDraft: Dispatch<SetStateAction<TemplateDraft>>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
}

/** Loads the template (and its edit draft in edit mode) into the studio's state. */
export function useTemplateStudioLoad({
  client,
  mode,
  templateId,
  key,
  scope,
  loadVersion,
  recoveredDraft,
  initialDraft,
  resumeOperationId,
  editAttemptKey,
  setTemplate,
  setEditOperation,
  setStaleEditDraft,
  setEditConflict,
  setLoading,
  setCopyingFiles,
  setDraft,
  setError,
}: TemplateStudioLoad): void {
  useEffect(() => {
    if (mode === 'capture' || templateId === undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded = await client.query(templateById(templateId), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setTemplate(loaded);
        let loadedEditDraft: TemplateEditDraft | null = null;
        if (mode === 'edit') {
          if (resumeOperationId !== null) {
            try {
              loadedEditDraft = await client.query(
                templateEditDraftById(templateId, resumeOperationId),
                { signal: controller.signal, forceRefresh: true },
              );
            } catch (reason) {
              if (isCanceledError(reason)) return;
              if (!isNixApiError(reason) || reason.status !== 409) throw reason;
              setStaleEditDraft(true);
              setLoading(false);
              return;
            }
          }
          if (loadedEditDraft === null) {
            const endpoint = beginTemplateEditDraft(templateId, editAttemptKey);
            let first = await client.execute(endpoint, { signal: controller.signal });
            if (first.fileTransferPending === true) {
              const receipt: TemplateDraft = {
                ...initialDraft,
                idempotencyKey: editAttemptKey,
                operationId: first.operationId,
                fileTransferJobId: first.fileTransferJobId ?? null,
              };
              browserSessionStorage()?.setItem(key, JSON.stringify(receipt));
              setDraft(receipt);
              setCopyingFiles(true);
              try {
                first = await resumeTemplateFileTransfer(
                  client,
                  first,
                  () => client.execute(endpoint, { signal: controller.signal }),
                  controller.signal,
                );
              } finally {
                setCopyingFiles(false);
              }
              const completedReceipt = { ...receipt, fileTransferJobId: null };
              browserSessionStorage()?.setItem(key, JSON.stringify(completedReceipt));
              setDraft(completedReceipt);
            }
            loadedEditDraft = first;
          }
          setEditOperation(loadedEditDraft);
          setStaleEditDraft(false);
        }
        if (!recoveredDraft) {
          const seeded = newDraft(authoredRootTitle(loaded), scope);
          const initialization = loadedEditDraft?.initialization ?? loaded.initialization;
          setDraft({
            ...seeded,
            description: loadedEditDraft?.description ?? loaded.description ?? '',
            idempotencyKey: loadedEditDraft === null ? seeded.idempotencyKey : editAttemptKey,
            includeBody: loaded.includeBody,
            includeChildren: loaded.includeChildren,
            operationId: loadedEditDraft?.operationId ?? null,
            expiresAt: loadedEditDraft?.expiresAt ?? null,
            selectedSourceId: loadedEditDraft?.root.sourceId ?? null,
            title: loadedEditDraft?.title ?? seeded.title,
            initialization,
            inputValues: Object.fromEntries(
              initialization.inputs.flatMap((input) =>
                input.defaultValue === null ? [] : [[input.key, input.defaultValue]],
              ),
            ),
          });
        } else if (loadedEditDraft !== null) {
          setDraft((current) => ({
            ...current,
            operationId: loadedEditDraft.operationId,
            expiresAt: loadedEditDraft.expiresAt,
            selectedSourceId: current.selectedSourceId ?? loadedEditDraft.root.sourceId,
          }));
        }
        setLoading(false);
      } catch (reason) {
        if (isCanceledError(reason)) return;
        setCopyingFiles(false);
        if (mode === 'edit' && isNixApiError(reason) && reason.status === 409) {
          setEditConflict(
            templateFailure(
              reason,
              'Another template draft is still active. Finish or discard it before trying again.',
            ),
          );
          setLoading(false);
          return;
        }
        setError(templateFailure(reason, 'This template could not be loaded.'));
        setLoading(false);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [
    client,
    editAttemptKey,
    initialDraft,
    key,
    loadVersion,
    mode,
    recoveredDraft,
    resumeOperationId,
    scope,
    templateId,
    setCopyingFiles,
    setDraft,
    setEditConflict,
    setEditOperation,
    setError,
    setLoading,
    setStaleEditDraft,
    setTemplate,
  ]);
}
