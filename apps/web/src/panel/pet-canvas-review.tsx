import { Button, Text } from '@nix/ui';
import { useAuth } from '@nix/web-platform/auth/auth-provider';
import { ApprovalActions } from '@nix/web-pets/pets/approval/approval-frame';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  checkCanvasReviewRevision,
  loadCanvasReviewScene,
  type CanvasReviewDraft,
} from './pet-canvas-review-scene';

const PreviewCanvas = lazy(async () => {
  const { NixCanvas } = await import('@nix/web-editor/editor/nix-canvas');
  return { default: NixCanvas };
});

interface CanvasReviewLayout {
  readonly activeId: string | null;
  readonly pane: HTMLDivElement | null;
  readonly select: Dispatch<SetStateAction<string | null>>;
  readonly setPane: (element: HTMLDivElement | null) => void;
}

const ReviewLayout = createContext<CanvasReviewLayout | null>(null);

export function usePetCanvasReview(): CanvasReviewLayout | null {
  return useContext(ReviewLayout);
}

export function PetCanvasReviewLayout({
  children,
}: {
  readonly children: (reviewOpen: boolean, closeReview: () => void) => ReactNode;
}): ReactElement {
  const [activeId, select] = useState<string | null>(null);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  return (
    <ReviewLayout.Provider value={{ activeId, pane, select, setPane }}>
      {children(activeId !== null, () => {
        select(null);
      })}
    </ReviewLayout.Provider>
  );
}

export function PetCanvasReviewPane({
  className = '',
}: {
  readonly className?: string;
}): ReactElement | null {
  const layout = usePetCanvasReview();
  const activeId = layout?.activeId;
  const setPane = layout?.setPane;
  const select = layout?.select;
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (activeId != null) back.current?.focus();
  }, [activeId]);
  if (activeId == null || select === undefined) return null;
  return (
    <section
      aria-label="Drawing review"
      className={`flex h-full min-h-0 min-w-0 flex-col bg-background ${className}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-divider px-3 py-2">
        <Text as="h2" variant="h5">
          Review drawing
        </Text>
        <Button
          ref={back}
          type="button"
          variant="ghost"
          onClick={() => {
            select(null);
          }}
        >
          Back to conversation
        </Button>
      </div>
      <div ref={setPane} className="flex min-h-0 min-w-0 flex-1 flex-col" />
    </section>
  );
}

type ReviewState =
  Awaited<ReturnType<typeof loadCanvasReviewScene>> | { readonly kind: 'loading' | 'unavailable' };

const collabUrl = () => new URL('/collab', window.location.origin).href;

export function PetCanvasDecision({
  draft: receivedDraft,
  heading,
  stale,
  busy,
  error,
  onApprove,
  onDecline,
  onRequestChanges,
  onRefresh,
  planReview,
}: {
  readonly draft: CanvasReviewDraft;
  readonly heading: string;
  readonly stale: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onApprove: () => Promise<void>;
  readonly onDecline: () => void;
  readonly onRequestChanges: (feedback: string) => void;
  readonly onRefresh: () => void;
  readonly planReview?: { readonly onReady: (ready: boolean) => void } | undefined;
}): ReactElement {
  const { getAccessToken } = useAuth();
  const headingId = useId();
  // Core pins the draft by ID. Feed updates can reissue the same draft while the person reviews it.
  const [draft] = useState(receivedDraft);
  const [load, setLoad] = useState(0);
  const [state, setState] = useState<ReviewState>({ kind: 'loading' });
  const [readyToView, setReadyToView] = useState(false);
  const [checking, setChecking] = useState(false);
  const checkRef = useRef<AbortController | null>(null);
  const canvasPalette = useRef<HTMLSpanElement>(null);
  const reportPlanReady = useEffectEvent((ready: boolean) => {
    planReview?.onReady(ready);
  });
  useEffect(() => {
    reportPlanReady(!stale && state.kind === 'ready' && readyToView);
    return () => {
      reportPlanReady(false);
    };
  }, [stale, state.kind, readyToView]);

  useEffect(() => {
    const palette = canvasPalette.current;
    if (stale || palette === null) return;
    // Excalidraw transforms the scene colors itself in dark mode.
    const colors = getComputedStyle(palette);
    const controller = new AbortController();
    async function read(): Promise<void> {
      try {
        const token = await getAccessToken();
        if (token === null) throw new Error('The session ended.');
        const scene = await loadCanvasReviewScene(
          {
            draft,
            collabUrl: collabUrl(),
            token,
            colors: {
              added: colors.getPropertyValue('--color-series-3').trim(),
              updated: colors.getPropertyValue('--color-accent-text').trim(),
              removed: colors.getPropertyValue('--color-danger').trim(),
            },
          },
          controller.signal,
        );
        if (!controller.signal.aborted) setState(scene);
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'unavailable' });
      }
    }
    void read();
    return () => {
      controller.abort();
    };
  }, [draft, getAccessToken, load, stale]);

  useEffect(() => {
    if (state.kind !== 'ready' || stale) return;
    const controller = new AbortController();
    let inFlight = false;
    async function check(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const token = await getAccessToken();
        if (token === null) throw new Error('The session ended.');
        const current = await checkCanvasReviewRevision(
          { draft, collabUrl: collabUrl(), token },
          controller.signal,
        );
        if (!controller.signal.aborted && current === 'stale') setState({ kind: 'stale' });
      } catch {
        if (!controller.signal.aborted) setState({ kind: 'unavailable' });
      } finally {
        inFlight = false;
      }
    }
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [draft, getAccessToken, stale, state.kind]);

  useEffect(() => () => checkRef.current?.abort(), []);

  async function approve(): Promise<void> {
    if (busy || stale || state.kind !== 'ready' || !readyToView || checkRef.current !== null)
      return;
    const controller = new AbortController();
    checkRef.current = controller;
    setChecking(true);
    try {
      const token = await getAccessToken();
      if (token === null) throw new Error('The session ended.');
      const current = await checkCanvasReviewRevision(
        { draft, collabUrl: collabUrl(), token },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (current === 'stale') setState({ kind: 'stale' });
      else await onApprove();
    } catch {
      if (!controller.signal.aborted) setState({ kind: 'unavailable' });
    } finally {
      if (!controller.signal.aborted) setChecking(false);
      checkRef.current = null;
    }
  }

  const changed = stale || state.kind === 'stale';
  return (
    <>
      <span ref={canvasPalette} data-theme-preview="" data-theme="light" hidden />
      <div className="min-h-0 min-w-0 flex-1">
        {!changed && state.kind === 'ready' ? (
          <Suspense fallback={<DrawingStatus>Loading drawing…</DrawingStatus>}>
            <PreviewCanvas
              elements={state.elements}
              fitToElementIds={state.focusIds}
              onReady={setReadyToView}
              onChange={() => undefined}
              readOnly
              allowFileUploads={false}
            />
          </Suspense>
        ) : (
          <DrawingStatus>
            {changed
              ? 'The canvas changed. Refresh the draft to review it again.'
              : state.kind === 'unavailable'
                ? 'The drawing could not be loaded. Check the canvas and try again.'
                : 'Loading drawing…'}
          </DrawingStatus>
        )}
      </div>
      <div className="flex max-h-full shrink-0 flex-col gap-2 overflow-y-auto border-t border-divider p-3">
        <Text variant="bodySmall" id={headingId}>
          {heading}
        </Text>
        {!changed && state.kind === 'ready' ? (
          <ul aria-label="Drawing changes" className="flex flex-wrap gap-x-3 gap-y-1">
            <ChangeLegend count={state.counts.added} label="added" marker="border-series-3" />
            <ChangeLegend
              count={state.counts.updated}
              label="edited"
              marker="border-dotted border-accent-text"
            />
            <ChangeLegend
              count={state.counts.removed}
              label="removed"
              marker="border-dashed border-danger"
            />
          </ul>
        ) : null}
        {error === null ? null : (
          <Text variant="note" role="alert">
            {error}
          </Text>
        )}
        {changed ? (
          <div>
            <Button type="button" disabled={busy || checking} onClick={onRefresh}>
              Refresh draft
            </Button>
          </div>
        ) : (
          <>
            {state.kind === 'unavailable' ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setReadyToView(false);
                    setState({ kind: 'loading' });
                    setLoad((current) => current + 1);
                  }}
                >
                  Check again
                </Button>
              </div>
            ) : null}
            {planReview === undefined ? (
              <ApprovalActions
                headingId={headingId}
                approveLabel="Apply drawing"
                busy={busy || checking}
                approveDisabled={!readyToView || state.kind !== 'ready'}
                onApprove={() => void approve()}
                onDecline={onDecline}
                onRequestChanges={onRequestChanges}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

function ChangeLegend({
  count,
  label,
  marker,
}: {
  readonly count: number;
  readonly label: string;
  readonly marker: string;
}): ReactElement | null {
  if (count === 0) return null;
  return (
    <li className="flex items-center gap-1">
      <span aria-hidden="true" className={`w-4 border-t-2 ${marker}`} />
      <Text as="span" variant="note" tone="muted">
        {count} {label}
      </Text>
    </li>
  );
}

function DrawingStatus({ children }: { readonly children: string }): ReactElement {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-3">
      <Text variant="bodySmall" tone="muted" role="status">
        {children}
      </Text>
    </div>
  );
}
