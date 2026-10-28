import { Button, Dialog, Text } from '@nix/ui';
import {
  imports as importResources,
  isNixApiError,
  type DocumentImport,
  type DocumentImportPlan,
} from '@nix/api-client';
import { EMPTY_MARKDOWN_IMPORT_SCAN } from '@nix/markdown/scan';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { ErrorPanel, PartialNotice } from '@nix/web-foundation/components/states/status-panels';
import {
  planImport,
  screenPaths,
  type ImportPlan,
  type PathReason,
  type PlannedNode,
} from './import-plan';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { recordInterruptedImport } from '@nix/web-foundation/lib/import-interrupted-notice';
import { runImportPlan, undoImport, type ImportRunReport } from './import-run';
import { useWorkspace } from '../workspaces/workspace-context';

/**
 * Importing Markdown into the workspace: preview first, then commit, then an honest report.
 *
 * **The preview is shown before anything is created**, because a mapping is a set of decisions -
 * which files become notes, which are skipped and why, what front matter turns into properties,
 * which links cannot be resolved - and the person should read them while there is still nothing to
 * regret. This is 7.5's order: preview, report, undo.
 *
 * **Only Markdown is read for the preview.** A folder pick delivers everything it holds, so the
 * selection is screened by path first (`screenPaths`); attachments stay opaque browser files until
 * upload and hidden tool directories are turned away before a byte is loaded.
 *
 * **A run in progress can always be stopped.** The trailing button becomes "Stop import" and the
 * dialog's close control stops rather than closes; what was created stays, the rest is reported
 * as not attempted, and the report renders as it would for any other partial run.
 *
 * **The report never rounds up.** A created item whose body write was refused is listed as
 * created, with the refusal beside it; an item the run never reached is listed as not attempted
 * with its reason. A partial import is said to be partial, in the service's own words where it
 * gave them.
 *
 * PDF, DOCX and TXT use the bounded document worker before entering the same preview and write
 * path. Their source bytes and extracted images are retained as child file items after the note.
 */

type Phase =
  | { readonly name: 'pick'; readonly reading: boolean; readonly error: string | null }
  | { readonly name: 'preview'; readonly plan: ImportPlan; readonly losses: readonly string[] }
  | { readonly name: 'working'; readonly done: number; readonly total: number }
  | {
      readonly name: 'document-preview';
      readonly operation: DocumentImport;
      readonly plan: DocumentImportPlan;
    }
  | { readonly name: 'document-working'; readonly importId: string; readonly total: number }
  | {
      readonly name: 'document-report';
      readonly operation: DocumentImport;
      readonly plan: DocumentImportPlan;
      readonly undo: UndoState;
    }
  | {
      readonly name: 'report';
      readonly report: ImportRunReport;
      readonly undo: UndoState;
      /** Kept so a run that could not start can be retried without re-picking. */
      readonly plan: ImportPlan;
      readonly losses: readonly string[];
    };

type UndoState =
  | { readonly name: 'available' }
  | { readonly name: 'working' }
  | { readonly name: 'done' }
  | { readonly name: 'failed'; readonly error: string };

/** Some browsers have no folder picker; offering the button there would silently pick files. */
const FOLDER_PICK_SUPPORTED =
  typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype;

export interface ImportDialogProps {
  readonly open: boolean;
  /** The item the import goes under; the workspace root when null. */
  readonly parentId: string | null;
  readonly getAccessToken: () => Promise<string | null>;
  readonly onClose: () => void;
  /** Called once when a run has created its root, so the shell can reveal it in the tree. */
  readonly onImported?: (rootItemId: string) => void;
}

export function ImportDialog({
  open,
  parentId,
  getAccessToken,
  onClose,
  onImported,
}: ImportDialogProps): ReactNode {
  const client = useApiClient();
  const { workspaceId } = useWorkspace();
  const [phase, setPhase] = useState<Phase>({ name: 'pick', reading: false, error: null });
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  const pickButton = useRef<HTMLButtonElement | null>(null);
  const backToPick = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const activeDocumentImport = useRef<string | null>(null);

  // Read in the unmount cleanup below, which otherwise closes over the render that scheduled the
  // effect - refs kept current by their own effect are how that cleanup sees the phase and
  // workspace that were actually on screen when the dialog went away, not stale ones.
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  const phaseRef = useRef(phase);
  const workspaceIdRef = useRef(workspaceId);
  const subjectRef = useRef(subject);
  useEffect(() => {
    phaseRef.current = phase;
    workspaceIdRef.current = workspaceId;
    // Only ever overwritten with a real subject: an expiring session clears the profile before
    // this dialog unmounts, and the notice must still name the person whose import it was.
    if (subject !== null) {
      subjectRef.current = subject;
    }
  }, [phase, workspaceId, subject]);

  // The "Choose different files" button unmounts with the preview; hand focus to the pick step's primary button.
  useEffect(() => {
    if (phase.name === 'pick' && backToPick.current) {
      backToPick.current = false;
      pickButton.current?.focus();
    }
  }, [phase.name]);

  useEffect(
    () => () => {
      // Unmounting the whole screen mid-run: stop between items so what was created stays and
      // nothing more is made for a report nobody will see.
      abort.current?.abort();

      // A run that was still in progress when this unmount happened was never closed through the
      // dialog's own controls - "Stop import" keeps the dialog mounted long enough to show its
      // report, and the close/cancel buttons are disabled while working. So this branch is
      // specifically the screen being torn down out from under an in-progress import - a session
      // expiring mid-task chief among them - not a person choosing to leave. What was already
      // created stays in the workspace with no report and no undo offered, so a short, content-free
      // summary is left for the workspace to show once the person is back in it.
      const current = phaseRef.current;
      if (current.name === 'working' && current.done > 0 && subjectRef.current !== null) {
        recordInterruptedImport({
          subject: subjectRef.current,
          workspaceId: workspaceIdRef.current,
          createdCount: current.done,
          totalCount: current.total,
        });
      }
    },
    [],
  );

  async function chose(files: readonly File[]): Promise<void> {
    if (files.length === 0) {
      return;
    }
    setPhase({ name: 'pick', reading: true, error: null });

    try {
      const document = files.length === 1 ? documentFormat(files[0]?.name ?? '') : null;
      if (document !== null && files[0] !== undefined) {
        const file = files[0];
        abort.current?.abort();
        const controller = new AbortController();
        abort.current = controller;
        const preview = await importResources.beginAndPreviewDocument(
          client,
          {
            workspaceId,
            parentId,
            format: document,
            title: withoutExtension(file.name),
            fileName: file.name,
            mediaType: documentMediaType(document, file.type),
            byteLength: file.size,
            idempotencyKey: `web-document:${crypto.randomUUID()}`,
          },
          file,
          controller.signal,
          (importId) => {
            activeDocumentImport.current = importId;
          },
        );
        setPhase({
          name: 'document-preview',
          operation: preview.operation,
          plan: preview.plan,
        });
        return;
      }
      // Screen by path before reading. Attachments stay as browser files until upload; only
      // Markdown is read for planning, so a large vault does not cost its attachment bytes twice.
      const paths = files.map(pathOf);
      const screened = screenPaths(paths);
      const wanted = files.filter((_, index) => screened.wanted[index] === true);

      if (wanted.length === 0) {
        setPhase({
          name: 'pick',
          reading: false,
          error: `Nothing importable was chosen: ${distinctReasons(screened.skipped)}.`,
        });
        return;
      }

      // The parser subpath, not the package root, so the lazy chunk carries only the inbound
      // direction. Loaded in parallel with Markdown file reads.
      const [{ markdownToDocument }, sources] = await Promise.all([
        import('@nix/markdown/from-markdown'),
        Promise.all(
          wanted.map(async (file) =>
            file.name.toLowerCase().endsWith('.md')
              ? { path: pathOf(file), text: await file.text() }
              : { path: pathOf(file), file },
          ),
        ),
      ]);

      const plan = planImport(sources, markdownToDocument, undefined, screened.skipped);
      if (plan.root === null) {
        setPhase({
          name: 'pick',
          reading: false,
          error:
            plan.failed.length > 0
              ? `The chosen files could not become notes: ${distinctReasons(plan.failed)}.`
              : `Nothing importable was chosen: ${distinctReasons(plan.skipped)}.`,
        });
        return;
      }
      setPhase({ name: 'preview', plan, losses: [] });
    } catch (reason) {
      setPhase({
        name: 'pick',
        reading: false,
        error: isNixApiError(reason)
          ? (reason.detail ?? 'The document could not be converted.')
          : reason instanceof Error
            ? reason.message
            : 'The files could not be read. Choose them again.',
      });
    }
  }

  async function run(plan: ImportPlan, losses: readonly string[] = []): Promise<void> {
    if (plan.root === null) {
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    setPhase({ name: 'working', done: 0, total: plan.totalItems });
    try {
      const report = await runImportPlan({
        workspaceId,
        plan: plan.root,
        parentId,
        client,
        getAccessToken,
        signal: controller.signal,
        onProgress: (done, total) => {
          setPhase({ name: 'working', done, total });
        },
      });

      if (report.rootItemId !== null) onImported?.(report.rootItemId);
      setPhase({ name: 'report', report, undo: { name: 'available' }, plan, losses });
    } catch (cause) {
      // The run loop is written not to throw; this is insurance against the bug that proves it
      // wrong, and it must not strand the dialog in `working` with no exit.
      console.error('Import run failed unexpectedly:', cause);
      setPhase({
        name: 'pick',
        reading: false,
        error:
          'The import failed unexpectedly. Some items may already have been created - check the tree, then try again.',
      });
    }
  }

  async function runDocument(current: Extract<Phase, { name: 'document-preview' }>): Promise<void> {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    activeDocumentImport.current = current.operation.id;
    setPhase({
      name: 'document-working',
      importId: current.operation.id,
      total: current.operation.itemCount ?? current.plan.items.length,
    });
    try {
      const completed = await importResources.commitAndWaitDocumentImport(
        client,
        current.operation.id,
        controller.signal,
      );
      activeDocumentImport.current = null;
      if (completed.rootItemId !== null) onImported?.(completed.rootItemId);
      setPhase({
        name: 'document-report',
        operation: completed,
        plan: current.plan,
        undo: { name: 'available' },
      });
    } catch (reason) {
      if (controller.signal.aborted) {
        setPhase({ name: 'pick', reading: false, error: 'The document import was cancelled.' });
        return;
      }
      activeDocumentImport.current = null;
      setPhase({
        name: 'pick',
        reading: false,
        error: isNixApiError(reason)
          ? (reason.detail ?? 'The document import was refused.')
          : reason instanceof Error
            ? reason.message
            : 'The document import was refused.',
      });
    }
  }

  function stop(): void {
    abort.current?.abort();
    const importId = activeDocumentImport.current;
    activeDocumentImport.current = null;
    if (importId !== null) void client.execute(importResources.cancelDocumentImport(importId));
  }

  function discardDocument(importId: string): void {
    activeDocumentImport.current = null;
    void client.execute(importResources.cancelDocumentImport(importId)).catch(() => undefined);
  }

  async function undo(current: Extract<Phase, { name: 'report' }>): Promise<void> {
    if (current.report.rootItemId === null) {
      return;
    }
    setPhase({ ...current, undo: { name: 'working' } });
    const outcome = await undoImport(client, workspaceId, current.report.rootItemId);
    setPhase({
      ...current,
      undo: outcome.ok
        ? { name: 'done' }
        : { name: 'failed', error: outcome.error ?? 'The undo was refused.' },
    });
  }

  async function undoDocument(current: Extract<Phase, { name: 'document-report' }>): Promise<void> {
    if (current.operation.rootItemId === null) return;
    setPhase({ ...current, undo: { name: 'working' } });
    const outcome = await undoImport(client, workspaceId, current.operation.rootItemId);
    setPhase({
      ...current,
      undo: outcome.ok
        ? { name: 'done' }
        : { name: 'failed', error: outcome.error ?? 'The undo was refused.' },
    });
  }

  const working =
    phase.name === 'working' ||
    phase.name === 'document-working' ||
    (phase.name === 'pick' && phase.reading);

  function closeDialog(): void {
    if (phase.name === 'document-preview') discardDocument(phase.operation.id);
    onClose();
  }

  return (
    <Dialog
      open={open}
      title="Import"
      // While a run is in flight, every way out - Escape, the backdrop, the X - stops the run
      // rather than abandoning it; the report then says what was made and what was not.
      onClose={working ? stop : closeDialog}
      actions={
        working ? (
          <Button variant="secondary" onClick={stop}>
            Stop import
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={closeDialog}>
              {phase.name === 'report' || phase.name === 'document-report' ? 'Done' : 'Cancel'}
            </Button>
            {phase.name === 'preview' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    backToPick.current = true;
                    setPhase({ name: 'pick', reading: false, error: null });
                  }}
                >
                  Choose different files
                </Button>
                <Button
                  onClick={() => {
                    void run(phase.plan, phase.losses);
                  }}
                >
                  Import {String(phase.plan.totalItems)}{' '}
                  {phase.plan.totalItems === 1 ? 'item' : 'items'}
                </Button>
              </>
            ) : null}
            {phase.name === 'document-preview' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => {
                    discardDocument(phase.operation.id);
                    backToPick.current = true;
                    setPhase({ name: 'pick', reading: false, error: null });
                  }}
                >
                  Choose a different file
                </Button>
                <Button
                  onClick={() => {
                    void runDocument(phase);
                  }}
                >
                  Import {String(phase.operation.itemCount ?? phase.plan.items.length)} items
                </Button>
              </>
            ) : null}
          </>
        )
      }
    >
      <div className="flex min-w-0 flex-col gap-4 break-words">
        {/* One live region for the dialog's whole life, mounted before any of its texts, so phase
            changes are actually announced - a region inserted together with its text is the
            canonical reason one never speaks (see a11y/announcer.ts). Deliberately coarse: phases,
            not per-item progress. */}
        <div role="status" className="sr-only">
          {liveText(phase)}
        </div>

        {phase.name === 'pick' ? (
          <>
            <Text tone="muted" variant="body">
              Choose a PDF, Word document, UTF-8 text file, Nix archive, Markdown files, an Obsidian
              vault, or folders containing Markdown notes and attachments. Documents become editable
              notes and their original files are retained as children. Markdown folders keep their
              hierarchy, supported formatting, and non-hidden attachments.
            </Text>
            <Text tone="muted" variant="note">
              PDF import extracts existing text but does not perform OCR. The preview names content
              that cannot be preserved before anything is created.
            </Text>
            <div className="flex flex-wrap gap-2">
              {/* Out of the tab order and the a11y tree: the visible buttons are the controls, and
                  a focusable but invisible input is a focus ring nobody can see. */}
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                aria-label="Markdown files to import"
                onChange={(event) => {
                  // Snapshot before resetting: browsers can clear the existing FileList in place.
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void chose(files);
                }}
              />
              <input
                ref={folderInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                aria-label="Folder to import"
                {...{ webkitdirectory: '' }}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  void chose(files);
                }}
              />
              {FOLDER_PICK_SUPPORTED ? (
                <Button
                  disabled={phase.reading}
                  onClick={() => {
                    folderInput.current?.click();
                  }}
                >
                  Choose a vault or folder
                </Button>
              ) : null}
              <Button
                ref={pickButton}
                variant="secondary"
                disabled={phase.reading}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Choose files
              </Button>
            </div>
            {FOLDER_PICK_SUPPORTED ? null : (
              <Text tone="muted" variant="note">
                This browser cannot select folders. You can still choose Markdown files.
              </Text>
            )}
            {phase.reading ? <Text tone="muted">Reading the files…</Text> : null}
            {phase.error !== null ? (
              <div role="alert">
                <Text tone="muted">{phase.error}</Text>
              </div>
            ) : null}
          </>
        ) : null}

        {phase.name === 'preview' ? <Preview plan={phase.plan} losses={phase.losses} /> : null}

        {phase.name === 'document-preview' ? (
          <DocumentPreview operation={phase.operation} plan={phase.plan} />
        ) : null}

        {phase.name === 'working' ? (
          <Text tone="muted">
            Importing… {String(phase.done)} of {String(phase.total)} items.
          </Text>
        ) : null}

        {phase.name === 'document-working' ? (
          <Text tone="muted">Publishing {String(phase.total)} imported items atomically…</Text>
        ) : null}

        {phase.name === 'report' ? (
          <Report
            report={phase.report}
            losses={phase.losses}
            undo={phase.undo}
            onUndo={() => {
              void undo(phase);
            }}
            onRetry={
              phase.report.couldNotStart === undefined
                ? undefined
                : () => {
                    void run(phase.plan, phase.losses);
                  }
            }
          />
        ) : null}

        {phase.name === 'document-report' ? (
          <DocumentReport
            operation={phase.operation}
            plan={phase.plan}
            undo={phase.undo}
            onUndo={() => {
              void undoDocument(phase);
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}

/** What the single live region says; coarse on purpose - phases, never per-item counts. */
function liveText(phase: Phase): string {
  switch (phase.name) {
    case 'pick':
      return phase.reading ? 'Reading the chosen files.' : '';
    case 'preview':
      return previewLiveText(phase.plan);
    case 'document-preview':
      return `Preview ready: ${String(phase.operation.itemCount ?? phase.plan.items.length)} items to import.`;
    case 'working':
      return `Importing ${String(phase.total)} items.`;
    case 'document-working':
      return `Publishing ${String(phase.total)} imported items.`;
    case 'report':
      return reportHeadline(phase.report);
    case 'document-report':
      return `${String(phase.operation.itemCount ?? phase.plan.items.length)} imported items were created.`;
  }
}

function previewLiveText(plan: ImportPlan): string {
  const parts = [`Preview ready: ${String(plan.totalItems)} items to import.`];
  const changes = contentChangeCount(planSources(plan.root));
  if (changes > 0) {
    parts.push(
      `${String(changes)} content ${changes === 1 ? 'change needs' : 'changes need'} review.`,
    );
  }
  if (plan.skipped.length > 0) {
    parts.push(
      `${String(plan.skipped.length)} ${plan.skipped.length === 1 ? 'file will' : 'files will'} be skipped.`,
    );
  }
  if (plan.failed.length > 0) {
    parts.push(
      `${String(plan.failed.length)} ${plan.failed.length === 1 ? 'file cannot' : 'files cannot'} become notes.`,
    );
  }
  return parts.join(' ');
}

function reportHeadline(report: ImportRunReport): string {
  if (report.couldNotStart !== undefined) {
    return 'The import could not start.';
  }
  if (report.created.length === 0) {
    return 'Nothing was imported.';
  }
  const whole =
    report.failed.length === 0 &&
    report.notAttempted.length === 0 &&
    !report.stoppedEarly &&
    !report.created.some((row) => row.bodyError !== undefined || row.propertiesError !== undefined);
  const count = `${String(report.created.length)} ${report.created.length === 1 ? 'item was' : 'items were'} created`;
  return whole ? `${count}.` : `${count}, but not everything made it across.`;
}

/** Moves focus to the phase's first line, so the place lost with the pressed button is replaced. */
function FocusOnMount({ children }: { readonly children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div tabIndex={-1} ref={ref}>
      {children}
    </div>
  );
}

function Preview({
  plan,
  losses,
}: {
  readonly plan: ImportPlan;
  readonly losses: readonly string[];
}): ReactNode {
  const root = plan.root;
  if (root === null) {
    return null;
  }
  const contentItems = plan.totalItems - containers(root);
  const sources = planSources(root);

  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(contentItems)} {contentItems === 1 ? 'file or note' : 'files and notes'} from the
          chosen files will be created under a new item called &ldquo;{root.title}&rdquo; -{' '}
          {String(plan.totalItems)} items in all, counting folders. Nothing is created until you
          press Import.
        </Text>
      </FocusOnMount>
      {losses.map((loss) => (
        <PartialNotice key={loss} pending={loss} />
      ))}
      {groupByReason(plan.skipped).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} will be skipped - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(plan.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'file' : 'files'} cannot become notes - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      <ContentChanges sources={sources} mode="preview" />
    </>
  );
}

function Report({
  report,
  losses,
  undo,
  onUndo,
  onRetry,
}: {
  readonly report: ImportRunReport;
  readonly losses: readonly string[];
  readonly undo: UndoState;
  readonly onUndo: () => void;
  readonly onRetry?: (() => void) | undefined;
}): ReactNode {
  if (report.couldNotStart !== undefined) {
    return (
      <ErrorPanel
        title="The import could not start"
        detail={report.couldNotStart}
        action={
          onRetry === undefined ? undefined : (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    );
  }

  if (report.created.length === 0) {
    // A run that made nothing is a refusal, not a partial: an alert, not a status beside content
    // that does not exist.
    return (
      <ErrorPanel
        title="Nothing was imported"
        detail={
          report.failed.length > 0
            ? `${withoutDot(distinctReasons(report.failed))}.`
            : (report.stopReason ??
              'The run made nothing and gave no reason - which is a bug worth reporting.')
        }
      />
    );
  }

  const lossy = report.created.filter(
    (row) => row.bodyError !== undefined || row.propertiesError !== undefined,
  );

  return (
    <>
      <FocusOnMount>
        <Text variant="body">{reportHeadline(report)}</Text>
      </FocusOnMount>
      {report.stopReason !== undefined ? (
        <PartialNotice pending={`${withoutDot(report.stopReason)}.`} />
      ) : null}
      {losses.map((loss) => (
        <PartialNotice key={loss} pending={loss} />
      ))}
      {lossy.length > 0 ? (
        <PartialNotice
          pending={`${String(lossy.length)} created ${lossy.length === 1 ? 'item' : 'items'} lost part of ${lossy.length === 1 ? 'its' : 'their'} content: ${lossy
            .map(
              (row) => `${row.title} (${withoutDot(row.bodyError ?? row.propertiesError ?? '')})`,
            )
            .join('; ')}.`}
        />
      ) : null}
      <ContentChanges sources={report.created} mode="receipt" />
      {groupByReason(report.failed).map((group) => (
        <PartialNotice
          key={`fail-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item' : 'items'} failed - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {groupByReason(report.notAttempted).map((group) => (
        <PartialNotice
          key={`skip-${group.reason}`}
          pending={`${String(group.paths.length)} ${group.paths.length === 1 ? 'item was' : 'items were'} not attempted - ${withoutDot(group.reason)}: ${pathsClause(group.paths)}.`}
        />
      ))}
      {report.rootItemId !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={onUndo} disabled={undo.name !== 'available'}>
            {undo.name === 'working' ? 'Undoing…' : undo.name === 'done' ? 'Undone' : 'Undo import'}
          </Button>
          {undo.name === 'done' ? (
            <Text tone="muted" variant="note" as="span">
              The imported items were moved to deleted; they can be restored.
            </Text>
          ) : null}
          {undo.name === 'failed' ? (
            <div role="alert">
              <Text tone="muted" variant="note" as="span">
                {undo.error}
              </Text>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function DocumentPreview({
  operation,
  plan,
}: {
  readonly operation: DocumentImport;
  readonly plan: DocumentImportPlan;
}): ReactNode {
  const titles = new Map(plan.items.map((item) => [item.sourceId, item.title]));
  const shown = plan.items.slice(0, 100);
  const remaining = plan.items.length - shown.length;
  const losses = operation.loss ?? plan.loss;
  const omissions = operation.omissions ?? plan.omissions;

  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(operation.itemCount ?? plan.items.length)} items will be published together under
          &ldquo;{operation.title}&rdquo;. Nothing is visible until every note body and retained
          file is ready.
        </Text>
      </FocusOnMount>
      {losses.map((loss) => (
        <PartialNotice key={`loss-${loss}`} pending={loss} />
      ))}
      {omissions.map((omission) => (
        <PartialNotice key={`omission-${omission}`} pending={`Omitted: ${omission}`} />
      ))}
      <div>
        <Text variant="h5" as="h2">
          Item mapping
        </Text>
        <ul className="mt-2 space-y-2">
          {shown.map((item) => (
            <li key={item.sourceId} className="rounded-md bg-surface p-3 shadow-sm">
              <Text as="span" variant="body">
                {item.title} becomes a {item.itemType}
                {item.parentSourceId === null
                  ? ' at the chosen destination'
                  : ` under ${titles.get(item.parentSourceId) ?? item.parentSourceId}`}
                {item.file === undefined ? '' : ` (${item.file.mediaType}, retained as a file)`}.
              </Text>
            </li>
          ))}
        </ul>
        {remaining > 0 ? (
          <Text tone="muted" variant="note" className="mt-2">
            {String(remaining)} more mapped items are included in the atomic import.
          </Text>
        ) : null}
      </div>
    </>
  );
}

function DocumentReport({
  operation,
  plan,
  undo,
  onUndo,
}: {
  readonly operation: DocumentImport;
  readonly plan: DocumentImportPlan;
  readonly undo: UndoState;
  readonly onUndo: () => void;
}): ReactNode {
  const count = operation.itemCount ?? plan.items.length;
  return (
    <>
      <FocusOnMount>
        <Text variant="body">
          {String(count)} {count === 1 ? 'item was' : 'items were'} created atomically.
        </Text>
      </FocusOnMount>
      {(operation.loss ?? plan.loss).map((loss) => (
        <PartialNotice key={`receipt-loss-${loss}`} pending={loss} />
      ))}
      {(operation.omissions ?? plan.omissions).map((omission) => (
        <PartialNotice key={`receipt-omission-${omission}`} pending={`Omitted: ${omission}`} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={onUndo} disabled={undo.name !== 'available'}>
          {undo.name === 'working' ? 'Undoing…' : undo.name === 'done' ? 'Undone' : 'Undo import'}
        </Button>
        {undo.name === 'done' ? (
          <Text tone="muted" variant="note" as="span">
            The imported items were moved to deleted; they can be restored.
          </Text>
        ) : null}
        {undo.name === 'failed' ? (
          <div role="alert">
            <Text tone="muted" variant="note" as="span">
              {undo.error}
            </Text>
          </div>
        ) : null}
      </div>
    </>
  );
}

function pathOf(file: File): string {
  // Optional in fact, not just in type: only a folder pick fills it, and test doubles of File do
  // not carry it at all.
  return typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
    ? file.webkitRelativePath
    : file.name;
}

function documentFormat(name: string): 'nix' | 'docx' | 'pdf' | 'txt' | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.nix')) return 'nix';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.txt')) return 'txt';
  return null;
}

function documentMediaType(format: 'nix' | 'docx' | 'pdf' | 'txt', browserType: string): string {
  if (format === 'pdf') return 'application/pdf';
  if (format === 'txt') return 'text/plain';
  if (format === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return browserType || 'application/vnd.nix.archive';
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

interface ReasonGroup {
  readonly reason: string;
  readonly paths: readonly string[];
}

/** One group per distinct reason, each keeping the paths it covers - never a bare count. */
function groupByReason(rows: readonly PathReason[]): readonly ReasonGroup[] {
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const paths = groups.get(row.reason);
    if (paths === undefined) {
      groups.set(row.reason, [row.path]);
    } else {
      paths.push(row.path);
    }
  }
  return [...groups.entries()].map(([reason, paths]) => ({ reason, paths }));
}

/** The first few paths by name, then an honest count of the rest. */
function pathsClause(paths: readonly string[]): string {
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${String(rest)} more` : shown.join(', ');
}

/** The distinct reasons, joined; used where paths would drown the sentence. */
function distinctReasons(rows: readonly PathReason[]): string {
  return [...new Set(rows.map((row) => withoutDot(row.reason)))].join('; ');
}

/** Reasons arrive both as fragments and as full sentences; strip the dot so ours is the only one. */
function withoutDot(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

function containers(node: PlannedNode): number {
  let total = node.kind === 'container' ? 1 : 0;
  for (const child of node.children) {
    total += containers(child);
  }
  return total;
}

interface ContentChangeSource {
  readonly path: string;
  readonly scan: PlannedNode['scan'];
  readonly droppedFrontMatter: readonly string[];
  readonly bodyError?: string;
}

function planSources(node: PlannedNode | null): readonly ContentChangeSource[] {
  const sources: ContentChangeSource[] = [];
  if (node !== null) {
    collectPlanSources(node, sources);
  }
  return sources;
}

function collectPlanSources(node: PlannedNode, sources: ContentChangeSource[]): void {
  sources.push(node);
  for (const child of node.children) {
    collectPlanSources(child, sources);
  }
}

function contentChangeCount(sources: readonly ContentChangeSource[]): number {
  return sources.reduce(
    (total, source) =>
      total +
      effectiveScan(source).unresolvedWikiLinks +
      effectiveScan(source).unresolvedObsidianEmbeds +
      effectiveScan(source).unresolvedLocalImages +
      effectiveScan(source).unsupportedImageAddresses +
      effectiveScan(source).inlineImagesFlattened +
      source.droppedFrontMatter.length,
    0,
  );
}

function ContentChanges({
  sources,
  mode,
}: {
  readonly sources: readonly ContentChangeSource[];
  readonly mode: 'preview' | 'receipt';
}): ReactNode {
  const messages = contentChangeMessages(sources, mode);
  if (messages.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby="import-content-changes-heading" className="flex flex-col gap-2">
      <Text id="import-content-changes-heading" variant="h6" as="h3">
        {mode === 'preview' ? 'Review before importing' : 'Changes in imported content'}
      </Text>
      <ul className="flex flex-col gap-2">
        {messages.map((message) => (
          <li key={message}>
            <Text variant="note" tone="muted">
              {message}
            </Text>
          </li>
        ))}
      </ul>
    </section>
  );
}

function effectiveScan(source: ContentChangeSource): PlannedNode['scan'] {
  return source.bodyError === undefined ? source.scan : EMPTY_MARKDOWN_IMPORT_SCAN;
}

function contentChangeMessages(
  sources: readonly ContentChangeSource[],
  mode: 'preview' | 'receipt',
): readonly string[] {
  const messages: string[] = [];
  const add = (
    read: (source: ContentChangeSource) => number,
    sentence: (count: number) => string,
  ) => {
    const count = sources.reduce((total, source) => total + read(source), 0);
    if (count === 0) {
      return;
    }
    const paths = sources.filter((source) => read(source) > 0).map((source) => source.path);
    messages.push(`${sentence(count)} Affected files: ${affectedPathsClause(paths)}.`);
  };

  add(
    (source) => effectiveScan(source).unresolvedWikiLinks,
    (count) =>
      mode === 'preview'
        ? `${String(count)} wiki ${count === 1 ? 'link will' : 'links will'} stay as text and will not open another note.`
        : `${String(count)} wiki ${count === 1 ? 'link stayed' : 'links stayed'} as text and ${count === 1 ? 'does' : 'do'} not open another note.`,
  );
  add(
    (source) => effectiveScan(source).unresolvedObsidianEmbeds,
    (count) =>
      mode === 'preview'
        ? `${String(count)} Obsidian ${count === 1 ? 'embed will' : 'embeds will'} stay as ![[...]] text; ${count === 1 ? 'the linked note or file will' : 'their linked notes or files will'} not be embedded.`
        : `${String(count)} Obsidian ${count === 1 ? 'embed was' : 'embeds were'} kept as ![[...]] text; ${count === 1 ? 'the linked note or file was' : 'their linked notes or files were'} not embedded.`,
  );
  add(
    (source) => effectiveScan(source).unresolvedLocalImages,
    (count) =>
      mode === 'preview'
        ? `${String(count)} local picture ${count === 1 ? 'path will be kept, but its picture file will not be copied, so it will' : 'paths will be kept, but picture files will not be copied, so they will'} not display in Nix.`
        : `${String(count)} local picture ${count === 1 ? 'path was kept, but its picture file was not copied, so it does' : 'paths were kept, but picture files were not copied, so they do'} not display in Nix.`,
  );
  add(
    (source) => effectiveScan(source).unsupportedImageAddresses,
    (count) =>
      mode === 'preview'
        ? `${String(count)} picture ${count === 1 ? 'address cannot' : 'addresses cannot'} be displayed safely; readable source text will be kept.`
        : `${String(count)} picture ${count === 1 ? 'address could' : 'addresses could'} not be displayed safely; readable source text was kept.`,
  );
  add(
    (source) => effectiveScan(source).inlineImagesFlattened,
    (count) =>
      mode === 'preview'
        ? `${String(count)} inline ${count === 1 ? 'picture will' : 'pictures will'} no longer display as ${count === 1 ? 'a picture' : 'pictures'}; ${count === 1 ? 'its link or readable text will be' : 'their links or readable text will be'} kept.`
        : `${String(count)} inline ${count === 1 ? 'picture no longer displays' : 'pictures no longer display'} as ${count === 1 ? 'a picture' : 'pictures'}; ${count === 1 ? 'its link or readable text was' : 'their links or readable text were'} kept.`,
  );
  add(
    (source) => source.droppedFrontMatter.length,
    (count) =>
      mode === 'preview'
        ? `${String(count)} unsupported front matter ${count === 1 ? 'line will' : 'lines will'} be left out.`
        : `${String(count)} unsupported front matter ${count === 1 ? 'line was' : 'lines were'} left out.`,
  );
  return messages;
}

function affectedPathsClause(paths: readonly string[]): string {
  const shown = paths.slice(0, 5);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join('; ')}; and ${String(rest)} more` : shown.join('; ');
}
