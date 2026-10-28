import { Button } from '@nix/ui';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router';

import type { CollabSync } from '../../editor/collab-sync';
import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import type { TemplateDetail, TemplateEditDraft } from '../template-api';
import type { TemplateLibrary } from '../use-templates';
import type { StudioMode, TemplateDraft } from '../template-studio-model';
import { StudioNotice } from '../template-studio-notice';

export interface StudioGateState {
  readonly mode: StudioMode;
  readonly workspaceId: string;
  readonly key: string;
  readonly sourceItemId: string | null;
  readonly draft: TemplateDraft;
  readonly template: TemplateDetail | null;
  readonly templateLibrary: TemplateLibrary;
  readonly loading: boolean;
  readonly copyingFiles: boolean;
  readonly error: string | null;
  readonly editConflict: string | null;
  readonly staleEditDraft: boolean;
  readonly navigate: NavigateFunction;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setLoading: Dispatch<SetStateAction<boolean>>;
  readonly setLoadVersion: Dispatch<SetStateAction<number>>;
  readonly setEditConflict: Dispatch<SetStateAction<string | null>>;
  readonly setStaleEditDraft: Dispatch<SetStateAction<boolean>>;
  readonly setEditOperation: Dispatch<SetStateAction<TemplateEditDraft | null>>;
  readonly setBodySync: Dispatch<SetStateAction<CollabSync | null>>;
  readonly setDraft: Dispatch<SetStateAction<TemplateDraft>>;
  readonly setResumeOperationId: Dispatch<SetStateAction<string | null>>;
  readonly setEditAttemptKey: Dispatch<SetStateAction<string>>;
}

/** The notice that replaces the studio while it cannot run, or null when it can. */
export function studioGate({
  mode,
  workspaceId,
  key,
  sourceItemId,
  draft,
  template,
  templateLibrary,
  loading,
  copyingFiles,
  error,
  editConflict,
  staleEditDraft,
  navigate,
  setError,
  setLoading,
  setLoadVersion,
  setEditConflict,
  setStaleEditDraft,
  setEditOperation,
  setBodySync,
  setDraft,
  setResumeOperationId,
  setEditAttemptKey,
}: StudioGateState): ReactNode {
  const templateCapabilities = templateLibrary.capabilities;
  const templateStatus = templateLibrary.status;
  if (mode === 'edit' && draft.fileTransferJobId !== null && error !== null) {
    return (
      <StudioNotice title="Template files need attention" detail={error} attention>
        <Button
          onClick={() => {
            setError(null);
            setLoading(true);
            setLoadVersion((current) => current + 1);
          }}
        >
          Retry file copy
        </Button>
      </StudioNotice>
    );
  }

  if (loading) {
    return (
      <StudioNotice
        title={copyingFiles ? 'Copying template files' : 'Loading template'}
        detail={
          copyingFiles
            ? 'Your file-copy receipt is saved in this tab. The template opens when Core confirms the copies.'
            : 'Reading its fields, views, and contents.'
        }
      />
    );
  }

  if (mode !== 'capture' && template === null) {
    return (
      <StudioNotice
        title="Template unavailable"
        detail={error ?? 'This template no longer exists.'}
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'capture' && sourceItemId === null) {
    return (
      <StudioNotice title="Choose an item first" detail="A template needs an item to capture." />
    );
  }

  if (mode === 'capture' && templateStatus === 'loading') {
    return <StudioNotice title="Checking template access" detail="Reading workspace access." />;
  }

  if (mode === 'capture' && templateStatus === 'error') {
    return (
      <StudioNotice
        title="Template access could not be checked"
        detail={templateLibrary.error ?? 'Check the connection and try again.'}
      >
        <Button variant="secondary" onClick={templateLibrary.reload}>
          Try again
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'capture' && !templateCapabilities.canManage) {
    return (
      <StudioNotice
        title="Template creation unavailable"
        detail="You can browse workspace templates, but you cannot add or change them."
      />
    );
  }

  if (
    (mode === 'create' || mode === 'apply') &&
    template !== null &&
    !template.capabilities.canApply
  ) {
    return (
      <StudioNotice
        title="Template use unavailable"
        detail="You can preview and download this template, but you cannot apply it in this workspace."
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && template?.capabilities.canEdit !== true) {
    return (
      <StudioNotice
        title="Managed template"
        detail="Built-in and file-managed templates are read-only. Use one to create an editable workspace item; the library template stays unchanged."
      >
        <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
          Back to templates
        </Button>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && editConflict !== null) {
    return (
      <StudioNotice title="Another template draft is active" detail={editConflict} attention>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setEditConflict(null);
              setLoading(true);
              setLoadVersion((current) => current + 1);
            }}
          >
            Try again
          </Button>
          <Button variant="secondary" onClick={() => void navigate(`/w/${workspaceId}/templates`)}>
            Back to templates
          </Button>
        </div>
      </StudioNotice>
    );
  }

  if (mode === 'edit' && staleEditDraft) {
    return (
      <StudioNotice
        title="This saved draft is no longer available"
        detail="Its document, canvas, or sheet edits cannot be recovered. Names, fields, and view changes saved in this tab are still here and can be reapplied to a fresh draft."
        attention
      >
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setLoading(true);
              setLoadVersion((current) => current + 1);
            }}
          >
            Try to resume again
          </Button>
          <Button
            onClick={() => {
              const nextAttemptKey = globalThis.crypto.randomUUID();
              setEditOperation(null);
              setBodySync(null);
              setDraft((current) => ({
                ...current,
                idempotencyKey: nextAttemptKey,
                operationId: null,
                expiresAt: null,
              }));
              setResumeOperationId(null);
              setEditAttemptKey(nextAttemptKey);
              setStaleEditDraft(false);
              setLoading(true);
            }}
          >
            Start a fresh draft
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              browserSessionStorage()?.removeItem(key);
              void navigate(`/w/${workspaceId}/templates`);
            }}
          >
            Discard local recovery
          </Button>
        </div>
      </StudioNotice>
    );
  }
  return null;
}
