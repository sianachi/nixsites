import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router';

import { emptyTemplateInitialization, isCanceledError } from '@nix/api-client';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import type { CollabSync } from '@nix/web-editor/editor/collab-sync';
import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import type { ShellContext } from '../shell/shell-context';
import { useWorkspace } from '../workspaces/workspace-context';
import {
  applyStoredTemplate,
  captureTemplate,
  discardTemplateEditDraft,
  preflightTemplate,
  resumeTemplateFileTransfer,
  type TemplateDetail,
  type TemplateEditDraft,
  type TemplatePreflight,
} from './template-api';
import { useTemplateLibrary } from './template-library-context';
import {
  draftScope,
  editedRootFacts,
  modeFromPath,
  newDraft,
  readDraft,
  storageKey,
  TEMPLATE_STUDIO_STEPS,
  type CaptureFacts,
  type TemplateDraft,
} from './template-studio-model';
import { Review } from './template-studio-facts';
import { TemplateStudioShell } from './template-studio-shell';
import { Basics, Contents } from './template-studio-steps';
import { StudioNotice } from './template-studio-notice';
import { templateFailure } from './use-templates';
import { saveTemplateEdit } from './studio/save-template-edit';
import { studioGate } from './studio/studio-gate';
import { useCaptureFacts } from './studio/use-capture-facts';
import { useTemplateStudioLoad } from './studio/use-template-studio-load';
import {
  createFields,
  destinationLabel,
  fileCopyStatus,
  finishLabelFor,
  studioTitle,
  requestInputValue,
  requestTemplateInputs,
} from './studio/studio-requests';

export function TemplateStudioPage(): ReactNode {
  const { templateId, itemId } = useParams();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const sourceItemId = searchParams.get('sourceItem');
  const { tree } = useOutletContext<ShellContext>();
  if (sourceItemId !== null && tree.status === 'loading') {
    return <StudioNotice title="Loading source item" detail="Reading the item to capture." />;
  }
  const scope = `${modeFromPath(pathname)}:${templateId ?? 'new'}:${itemId ?? sourceItemId ?? 'unknown'}:${searchParams.get('parent') ?? 'root'}`;
  return <TemplateStudio key={scope} />;
}

function TemplateStudio(): ReactNode {
  const { workspaceId } = useWorkspace();
  const { templateId, itemId } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const sourceItemId = searchParams.get('sourceItem');
  const parentItemId = searchParams.get('parent');
  const mode = modeFromPath(location.pathname);
  const scope = draftScope(mode, templateId, sourceItemId, itemId, parentItemId);
  const key = storageKey(workspaceId, mode, scope);
  const { tree } = useOutletContext<ShellContext>();
  const templateLibrary = useTemplateLibrary();
  const sourceTitle =
    sourceItemId === null
      ? 'Untitled template'
      : (tree.find(sourceItemId)?.title ?? 'Untitled template');
  const targetTitle = itemId === undefined ? null : (tree.find(itemId)?.title ?? 'Current item');
  const client = useApiClient();
  const navigate = useNavigate();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [editOperation, setEditOperation] = useState<TemplateEditDraft | null>(null);
  const [captureFacts, setCaptureFacts] = useState<CaptureFacts>({ status: 'loading' });
  const [loading, setLoading] = useState(mode !== 'capture');
  const [step, setStep] = useState(0);
  const [recovery] = useState(() => readDraft(key, newDraft(sourceTitle, scope)));
  const recoveredDraft = recovery.recovered;
  const initialDraft = recovery.draft;
  const [draft, setDraft] = useState<TemplateDraft>(initialDraft);
  const [resumeOperationId, setResumeOperationId] = useState(initialDraft.operationId);
  const [editAttemptKey, setEditAttemptKey] = useState(initialDraft.idempotencyKey);
  const [staleEditDraft, setStaleEditDraft] = useState(false);
  const [editConflict, setEditConflict] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [preflight, setPreflight] = useState<TemplatePreflight | null>(null);
  const [working, setWorking] = useState(false);
  const [copyingFiles, setCopyingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [bodySync, setBodySync] = useState<CollabSync | null>(null);
  const stepMainRef = useRef<HTMLElement>(null);
  const previousStep = useRef(step);
  const activeOperation = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      activeOperation.current?.abort();
    },
    [],
  );

  useTemplateStudioLoad({
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
  });
  useCaptureFacts(client, mode, sourceItemId, setCaptureFacts);

  useEffect(() => {
    browserSessionStorage()?.setItem(key, JSON.stringify(draft));
  }, [draft, key]);

  useEffect(() => {
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
    }
    globalThis.addEventListener('beforeunload', warn);
    return () => {
      globalThis.removeEventListener('beforeunload', warn);
    };
  }, []);

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = stepMainRef.current?.querySelector<HTMLElement>('h2');
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus();
  }, [step]);

  const gate = studioGate({
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
  });
  if (gate !== null) return gate;

  const destination = destinationLabel(
    mode,
    targetTitle,
    parentItemId,
    (id) => tree.find(id)?.title,
  );
  const title = studioTitle(mode, template?.title);
  const rootFacts =
    mode === 'edit'
      ? editedRootFacts(editOperation, draft)
      : mode === 'capture' && captureFacts.status === 'ready'
        ? captureFacts
        : null;
  const missingFactsLabel =
    mode === 'capture' && captureFacts.status !== 'ready'
      ? captureFacts.status === 'loading'
        ? 'Loading…'
        : 'Unavailable'
      : null;

  async function prepareReview(): Promise<boolean> {
    if ((mode !== 'create' && mode !== 'apply') || templateId === undefined) return true;
    const initialization = template?.initialization ?? emptyTemplateInitialization;
    const missingInput = initialization.inputs.find(
      (input) => input.required && requestInputValue(input, draft.inputValues).trim().length === 0,
    );
    if (missingInput !== undefined) {
      setError(`Enter ${missingInput.label} to continue.`);
      queueMicrotask(() => {
        stepMainRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return false;
    }
    setWorking(true);
    setError(null);
    activeOperation.current?.abort();
    const controller = new AbortController();
    activeOperation.current = controller;
    try {
      const result = await client.execute(
        preflightTemplate(templateId, {
          mode: mode === 'create' ? 'create' : 'merge',
          ...(mode === 'apply' && itemId !== undefined ? { targetItemId: itemId } : {}),
          ...(mode === 'create' ? createFields(template, draft, parentItemId) : {}),
          inputs: requestTemplateInputs(initialization, draft.inputValues),
          ...(template === null ? {} : { expectedRevision: template.revision }),
        }),
        { signal: controller.signal },
      );
      if (controller.signal.aborted || activeOperation.current !== controller) return false;
      setPreflight(result);
      if (!result.canApply) {
        setError(
          result.conflicts[0] ??
            'This template cannot be used here until its conflicts are resolved.',
        );
      }
      return result.canApply;
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return false;
      setError(templateFailure(reason, 'This template could not be checked.'));
      return false;
    } finally {
      if (activeOperation.current === controller) {
        activeOperation.current = null;
        setWorking(false);
      }
    }
  }

  async function finish(): Promise<void> {
    if (draft.title.trim().length === 0) {
      setError('Give this template a name.');
      return;
    }
    setWorking(true);
    setError(null);
    activeOperation.current?.abort();
    const controller = new AbortController();
    activeOperation.current = controller;
    try {
      if (mode === 'capture' && sourceItemId !== null) {
        const endpoint = captureTemplate({
          workspaceId,
          sourceItemId,
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          includeBody: draft.includeBody,
          includeChildren: draft.includeChildren,
          idempotencyKey: draft.idempotencyKey,
        });
        const first = await client.execute(endpoint, { signal: controller.signal });
        if (first.fileTransferPending === true) {
          const receipt = { ...draft, fileTransferJobId: first.fileTransferJobId ?? null };
          browserSessionStorage()?.setItem(key, JSON.stringify(receipt));
          setDraft(receipt);
          setCopyingFiles(true);
        }
        await resumeTemplateFileTransfer(
          client,
          first,
          () => client.execute(endpoint, { signal: controller.signal }),
          controller.signal,
        );
        if (first.fileTransferPending === true) setCopyingFiles(false);
        if (controller.signal.aborted || activeOperation.current !== controller) return;
        complete(`/w/${workspaceId}/templates`);
        return;
      }

      if (mode === 'edit') {
        if (template === null || editOperation === null) {
          throw new Error(
            'The template edit session is not ready. Reload the template before saving.',
          );
        }
        const saved = await saveTemplateEdit(
          client,
          template,
          editOperation,
          draft,
          controller.signal,
          () => activeOperation.current === controller,
        );
        if (saved === 'invalid') {
          setError('Every included item needs a name.');
          return;
        }
        if (saved === 'stale') return;
        complete(`/w/${workspaceId}/templates`);
        return;
      }

      if (templateId !== undefined) {
        const endpoint = applyStoredTemplate({
          templateId,
          mode: mode === 'apply' ? 'merge' : 'create',
          ...(mode === 'apply' && itemId !== undefined ? { targetItemId: itemId } : {}),
          ...(mode === 'create' ? createFields(template, draft, parentItemId) : {}),
          inputs: requestTemplateInputs(
            template?.initialization ?? emptyTemplateInitialization,
            draft.inputValues,
          ),
          ...(preflight === null ? {} : { expectedRevision: preflight.templateRevision }),
          idempotencyKey: draft.idempotencyKey,
        });
        const first = await client.execute(endpoint, { signal: controller.signal });
        if (first.fileTransferPending === true) {
          const receipt = { ...draft, fileTransferJobId: first.fileTransferJobId ?? null };
          browserSessionStorage()?.setItem(key, JSON.stringify(receipt));
          setDraft(receipt);
          setCopyingFiles(true);
        }
        const result = await resumeTemplateFileTransfer(
          client,
          first,
          () => client.execute(endpoint, { signal: controller.signal }),
          controller.signal,
        );
        if (first.fileTransferPending === true) setCopyingFiles(false);
        if (controller.signal.aborted || activeOperation.current !== controller) return;
        complete(`/w/${workspaceId}?item=${encodeURIComponent(result.targetItemId)}`);
      }
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setCopyingFiles(false);
      setError(templateFailure(reason, 'This template could not be saved.'));
    } finally {
      if (activeOperation.current === controller) {
        activeOperation.current = null;
        setWorking(false);
      }
    }
  }

  function complete(to: string): void {
    browserSessionStorage()?.removeItem(key);
    void navigate(to);
  }

  async function flushDraftBody(): Promise<boolean> {
    if (mode !== 'edit' || bodySync === null) return true;
    setWorking(true);
    setError(null);
    try {
      await bodySync.flushAndWait();
      return true;
    } catch {
      setError('The open body has not finished saving. Keep it open and try again.');
      return false;
    } finally {
      setWorking(false);
    }
  }

  async function goToStep(index: number): Promise<void> {
    if (index === step) return;
    if (index > step && mode !== 'apply' && draft.title.trim().length === 0) {
      setError('Give this template a name.');
      queueMicrotask(() => {
        stepMainRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
      });
      return;
    }
    if (step === 1 && !(await flushDraftBody())) return;
    if (index === TEMPLATE_STUDIO_STEPS.length - 1 && !(await prepareReview())) return;
    setError(null);
    setStep(index);
  }

  async function discard(): Promise<void> {
    if (mode === 'edit' && template !== null && editOperation !== null) {
      setWorking(true);
      try {
        await client.execute(discardTemplateEditDraft(template.id, editOperation.operationId));
      } catch (reason) {
        setError(templateFailure(reason, 'The draft could not be discarded.'));
        setWorking(false);
        setDiscarding(false);
        return;
      }
    }
    browserSessionStorage()?.removeItem(key);
    void navigate(-1);
  }

  return (
    <TemplateStudioShell
      mode={mode}
      title={title}
      destination={destination}
      step={step}
      working={working}
      statusMessage={fileCopyStatus(copyingFiles, draft.fileTransferJobId)}
      previewing={previewing}
      error={error}
      discarding={discarding}
      draft={draft}
      template={template}
      rootFacts={rootFacts}
      missingFactsLabel={missingFactsLabel}
      stepMainRef={stepMainRef}
      onRequestDiscard={() => {
        setDiscarding(true);
      }}
      onCloseDiscard={() => {
        setDiscarding(false);
      }}
      onDiscard={() => {
        void discard();
      }}
      onTogglePreview={() => {
        setPreviewing((value) => !value);
      }}
      onStepChange={(index) => {
        void goToStep(index);
      }}
      onBack={() => {
        void goToStep(step - 1);
      }}
      onNext={() => {
        void goToStep(Math.min(step + 1, TEMPLATE_STUDIO_STEPS.length - 1));
      }}
      onFinish={() => {
        void finish();
      }}
      finishLabel={finishLabelFor(mode)}
      finishDisabled={preflight?.canApply === false}
    >
      {step === 0 ? (
        <Basics
          mode={mode}
          draft={draft}
          destination={destination}
          targetTitle={targetTitle}
          initialization={template?.initialization ?? null}
          itemOptions={tree.items}
          onChange={(next) => {
            setDraft(next);
            setPreflight(null);
          }}
        />
      ) : step === 1 ? (
        <Contents
          mode={mode}
          draft={draft}
          template={template}
          editOperation={editOperation}
          bodySync={bodySync}
          itemOptions={tree.items}
          onBodySync={setBodySync}
          onChange={setDraft}
        />
      ) : (
        <Review
          mode={mode}
          draft={draft}
          template={template}
          preflight={preflight}
          destination={destination}
          rootFacts={rootFacts}
          missingFactsLabel={missingFactsLabel}
        />
      )}
    </TemplateStudioShell>
  );
}
