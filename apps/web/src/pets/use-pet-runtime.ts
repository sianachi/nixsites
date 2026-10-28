import { isCanceledError, isNixApiError, pets, type PetConnection } from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../api/api-client-provider';
import { ownerTurnContext } from './turn-context';
import { isAborted } from '../lib/guards';

/** The floor on how often the watch loop starts a new request, whether that request is the
 * next iteration of a normal poll or the very first one after a pause. */
const MIN_REQUEST_GAP_MS = 250;
/** A watch that answers with an unchanged revision faster than `MIN_REQUEST_GAP_MS` is not a
 * real long poll - the worker returned immediately rather than waiting on a change - so the
 * loop backs off by this much rather than hammering it in a tight cycle. */
const IMMEDIATE_UNCHANGED_DELAY_MS = 1000;
/** Backoff after consecutive watch failures: 1s, 2s, 4s, then capped at 10s for every failure
 * after that. A worker 429 arrives as an ordinary error here - it gets no special case. */
const BACKOFF_MS = [1000, 2000, 4000, 10000] as const;
/** How long the loop waits, while the panel is closed and there is nothing worth watching for,
 * before it re-checks whether that is still true. Not a network request - just a local check -
 * so this does not count against "do not poll a closed, idle panel". */
const IDLE_RECHECK_MS = 300;

export interface PetSendInput {
  readonly text: string;
  readonly model: string;
  readonly workspaceAccess: boolean;
  readonly readOnly?: boolean;
  readonly itemId?: string;
  /** The notes attached to this message; the server accepts five at most. */
  readonly itemIds?: readonly string[];
  readonly sharedText?: string;
  /** The user message this send replaces, with every message after it. */
  readonly replaceFromMessageId?: string;
  /** The workspace's main containers, for a conversation's first message only (plan B.2). */
  readonly workspaceMap?: readonly pets.PetWorkspaceMapEntry[];
}

/** What kind of request the current `error` describes, so the caller can offer the right
 * recovery action rather than one generic "Try again": `send` resubmits the same request,
 * `load` wakes the watch loop instead of issuing a fresh command, and `command` retries
 * whatever one-off request (interrupt, reset, an explicit reload) failed. */
export type PetRuntimeErrorKind = 'send' | 'load' | 'command';

export interface UsePetRuntimeResult {
  readonly runtime: PetConnection | null;
  readonly models: NonNullable<PetConnection['models']>;
  readonly error: string;
  readonly errorKind: PetRuntimeErrorKind | null;
  readonly busy: boolean;
  /** Applies a newer snapshot received elsewhere (a tool claim or result round trip). Ignored
   * once the pet or workspace this snapshot belongs to has moved on - see the generation
   * guard in the runtime effect below. */
  readonly setRuntime: (value: PetConnection) => void;
  /** Call whenever the draft that will become the next `send` changes, so a retried send of an
   * *edited* draft never reuses the request id of whatever was last attempted; an unedited retry
   * (a double click, a resend after a failed request) keeps the same id on purpose. */
  readonly regenerateRequestId: () => void;
  readonly send: (input: PetSendInput) => Promise<boolean>;
  readonly interrupt: () => Promise<void>;
  readonly reset: () => Promise<void>;
  readonly reload: () => Promise<void>;
  /** Wakes a watch loop that is mid-backoff after a load failure, rather than waiting out the
   * remaining delay - the retry action behind a `load` error's "Retry now". */
  readonly retryWatch: () => void;
}

function backoffDelay(failures: number): number {
  const index = Math.min(Math.max(0, failures - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[index] ?? 10000;
}

/** Resolves after `ms`, or immediately if the signal is already aborted / becomes aborted while
 * waiting - a wait this hook is stuck in must never outlive the component. `wake`, when given,
 * also resolves the wait the moment it fires - what lets the idle-panel recheck below react to
 * the panel opening right away, rather than up to `IDLE_RECHECK_MS` late, and what lets a
 * failed watch retry immediately rather than waiting out its backoff. */
function sleep(ms: number, signal: AbortSignal, wake?: EventTarget): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      wake?.removeEventListener('wake', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
    wake?.addEventListener('wake', finish, { once: true });
  });
}

/** Resolves immediately when the document is already visible; otherwise waits for the next
 * `visibilitychange` that makes it visible. This is both what pauses the watch loop while the
 * tab is hidden, and what makes the next iteration fire right away on becoming visible, rather
 * than owing the rest of whatever throttle or backoff delay it was mid-wait on. */
function waitUntilVisible(signal: AbortSignal): Promise<void> {
  if (signal.aborted || document.visibilityState !== 'hidden') return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      document.removeEventListener('visibilitychange', onVisible);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') finish();
    };
    document.addEventListener('visibilitychange', onVisible);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function hasPendingTool(runtime: PetConnection | null): boolean {
  return (runtime?.tools ?? []).some((tool) => tool.status === 'pending');
}

/**
 * Owns the companion runtime's connection: the watch loop, model discovery, and every mutation
 * against it (`send`, `interrupt`, `reset`, `reload`). Components use this hook for watches
 * and ordinary reads. PetWorkTools may read once to reconcile a refused tool claim against
 * another session; it does not start a second watch loop.
 *
 * `panelOpen` governs whether the watch loop keeps running while the caller's panel is closed:
 * it always runs while open, and while closed it keeps running only for as long as the last
 * known state is `thinking` or a tool is `pending` - never against an idle, closed panel.
 *
 * The request id behind `send` stays fixed until either a send succeeds or the caller calls
 * `regenerateRequestId` (wired to the composer's own change handler), so a retried send of an
 * unedited draft reaches the worker as the same request, while a retry of an edited draft is a
 * new one.
 *
 * Security S2: switching `petId` or `workspaceId` must never show the previous
 * conversation. Every time the runtime effect below restarts it clears the exposed `runtime` to
 * `null` immediately (rather than leaving the old snapshot on screen until the next watch
 * response), and bumps `generation` - a response that started under an earlier generation
 * (a watch tick, a command, or a tool `onChange` from `PetWorkTools`) is dropped rather than
 * applied once it arrives late, whichever of those three sources it came from.
 */
export function usePetRuntime(
  workspaceId: string,
  petId: string,
  panelOpen: boolean,
  rootItemId?: string,
): UsePetRuntimeResult {
  const client = useApiClient();
  const [runtime, setRuntimeState] = useState<PetConnection | null>(null);
  const [models, setModels] = useState<NonNullable<PetConnection['models']>>([]);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<PetRuntimeErrorKind | null>(null);
  // Keeps model failures separate from other commands so only model recovery clears them.
  const errorKindRef = useRef<PetRuntimeErrorKind | 'models' | null>(null);
  const reportError = useCallback((message: string, kind: PetRuntimeErrorKind | null) => {
    errorKindRef.current = kind;
    setError(message);
    setErrorKind(kind);
  }, []);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(crypto.randomUUID());
  const lifetime = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const modelRequest = useRef(0);
  const runtimeRef = useRef<PetConnection | null>(null);
  const panelOpenRef = useRef(panelOpen);
  const wake = useRef(new EventTarget());
  // Mutated synchronously by the runtime effect below on every restart; compared against the
  // generation a given response was issued under, so a stray setter (like `setRuntime`, bound
  // to whichever generation was current when its caller was handed it) can tell a late response
  // apart from a current one without the effect itself needing to depend on it.
  const generation = useRef(0);
  const [exposedGeneration, setExposedGeneration] = useState(0);
  const refuseNoteScope = useCallback(() => {
    generation.current += 1;
    lifetime.current?.abort();
    runtimeRef.current = null;
    setRuntimeState(null);
    setBusy(false);
    reportError(
      'This note is no longer available. Reopen it before continuing the conversation.',
      'load',
    );
  }, [reportError]);
  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (panelOpen) wake.current.dispatchEvent(new Event('wake'));
  }, [panelOpen]);

  const discoverModels = useCallback(() => {
    const controller = lifetime.current;
    const myGeneration = generation.current;
    if (!controller || controller.signal.aborted) return;
    const request = ++modelRequest.current;
    void client
      .execute(pets.runtime({ operation: 'models', workspaceId, petId }), {
        signal: controller.signal,
      })
      .then((value) => {
        if (
          !controller.signal.aborted &&
          myGeneration === generation.current &&
          request === modelRequest.current
        ) {
          setModels(value.models ?? []);
          if (errorKindRef.current === 'models') reportError('', null);
        }
      })
      .catch((cause: unknown) => {
        const detail =
          isNixApiError(cause) &&
          cause.kind === 'problem' &&
          cause.code.startsWith('pets.provider_')
            ? cause.detail?.trim()
            : undefined;
        if (
          detail &&
          !controller.signal.aborted &&
          myGeneration === generation.current &&
          request === modelRequest.current &&
          errorKindRef.current !== 'send'
        ) {
          setModels([]);
          reportError(detail, 'command');
          errorKindRef.current = 'models';
        }
      });
  }, [client, workspaceId, petId, reportError]);

  /** Core's keyless setup state has no worker revision. Entering it retires older conversation
   * responses; ordinary conversation snapshots still have to advance their revision. */
  const applyRaw = useCallback(
    (value: PetConnection) => {
      const setup =
        value.provider !== 'chatgpt' && value.status === 'disconnected' && value.revision === 0;
      if (!setup && value.revision < revision.current) return false;
      const previous = runtimeRef.current;
      if (setup && (previous?.status !== 'disconnected' || previous.revision !== 0)) {
        generation.current += 1;
        setExposedGeneration(generation.current);
        setModels([]);
        setBusy(false);
        reportError('', null);
      }
      revision.current = value.revision;
      runtimeRef.current = value;
      setRuntimeState(value);
      if (previous && previous.status !== 'connected' && value.status === 'connected')
        discoverModels();
      return true;
    },
    [discoverModels, reportError],
  );

  // Bound to whichever generation is current at the moment this identity is handed out; a
  // caller that received it earlier (a `PetWorkTools` instance whose in-flight `tool_result`
  // resolves after a pet or workspace switch) keeps calling this exact closure, so it still checks against
  // the generation it was minted under rather than whatever generation is live by then.
  const setRuntime = useCallback(
    (value: PetConnection) => {
      if (exposedGeneration !== generation.current) return;
      applyRaw(value);
    },
    [exposedGeneration, applyRaw],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Bumped synchronously, right here, so the generation check any in-flight response is
    // measured against (`myGeneration !== generation.current`) is already correct the instant
    // this effect starts - well before the deferred state clear below actually commits.
    generation.current += 1;
    const myGeneration = generation.current;
    revision.current = 0;
    runtimeRef.current = null;
    // S2: clear the exposed runtime before this generation's first watch response can arrive,
    // never leaving the previous pet's conversation on screen in the meantime. Deferred a
    // microtask, the same way `use-bookmarks.ts`'s loader defers its own first read: setting
    // state synchronously in an effect body is the cascading render
    // `react-hooks/set-state-in-effect` exists to stop.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || myGeneration !== generation.current) return;
      setRuntimeState(null);
      setModels([]);
      reportError('', null);
      setExposedGeneration(myGeneration);
    });
    discoverModels();

    let failures = 0;
    let nextEarliestStart = 0;

    // Nothing is known yet the first time this runs (`runtimeRef.current` is still `null`) - that
    // counts as "must watch", not "idle", so a panel that starts closed still learns the actual
    // state at least once instead of never fetching at all.
    const shouldWatch = () =>
      panelOpenRef.current ||
      runtimeRef.current === null ||
      runtimeRef.current.state === 'thinking' ||
      hasPendingTool(runtimeRef.current);

    const watch = async () => {
      while (!isAborted(controller.signal)) {
        if (!shouldWatch()) {
          await sleep(IDLE_RECHECK_MS, controller.signal, wake.current);
          continue;
        }
        await waitUntilVisible(controller.signal);
        if (isAborted(controller.signal)) break;
        if (!shouldWatch()) continue;
        const now = Date.now();
        if (now < nextEarliestStart)
          await sleep(nextEarliestStart - now, controller.signal, wake.current);
        if (isAborted(controller.signal)) break;
        const requestStart = Date.now();
        nextEarliestStart = requestStart + MIN_REQUEST_GAP_MS;
        const watchGeneration = generation.current;
        try {
          // `forceRefresh` is what keeps this an actual long poll rather than a cache read: two
          // watches in a row commonly carry the *same* `after` (nothing changed yet), and the
          // generic query cache would otherwise serve the first response straight back for up
          // to 30s without ever reaching the worker again.
          const result = await client.query(
            pets.watchRuntime({
              workspaceId,
              petId,
              after: revision.current,
              ...(rootItemId ? { rootItemId } : {}),
            }),
            { signal: controller.signal, forceRefresh: true },
          );
          if (isAborted(controller.signal)) break;
          if (watchGeneration !== generation.current) continue;
          const elapsed = Date.now() - requestStart;
          const unchanged = result.revision <= revision.current;
          applyRaw(result);
          failures = 0;
          if (errorKindRef.current === 'load') reportError('', null);
          if (unchanged && elapsed < MIN_REQUEST_GAP_MS)
            nextEarliestStart = Date.now() + IMMEDIATE_UNCHANGED_DELAY_MS;
        } catch (cause) {
          if (isCanceledError(cause) || isAborted(controller.signal)) break;
          if (watchGeneration !== generation.current) continue;
          if (rootItemId && isNixApiError(cause) && [403, 404, 409].includes(cause.status ?? 0)) {
            refuseNoteScope();
            break;
          }
          failures += 1;
          if (failures >= 2) {
            // Never overwrite a send or command failure the person has not acted on yet.
            if (errorKindRef.current === null || errorKindRef.current === 'load')
              reportError(
                'Conversation could not be loaded. Check your connection and try again.',
                'load',
              );
          }
          nextEarliestStart = Date.now() + backoffDelay(failures);
        }
      }
    };

    const refreshProvider = async () => {
      const requestGeneration = generation.current;
      try {
        const result = await client.execute(
          pets.runtime({
            operation: 'read',
            workspaceId,
            petId,
            ...(rootItemId ? { rootItemId } : {}),
          }),
          { signal: controller.signal },
        );
        if (controller.signal.aborted || requestGeneration !== generation.current) return;
        const needsModels =
          runtimeRef.current === null || runtimeRef.current.status === 'connected';
        if (applyRaw(result) && needsModels && result.status === 'connected') discoverModels();
      } catch (cause) {
        if (
          controller.signal.aborted ||
          isCanceledError(cause) ||
          requestGeneration !== generation.current
        )
          return;
        if (rootItemId && isNixApiError(cause) && [403, 404, 409].includes(cause.status ?? 0)) {
          refuseNoteScope();
          return;
        }
        if (errorKindRef.current === null || errorKindRef.current === 'load')
          reportError(
            'Conversation could not be loaded. Check your connection and try again.',
            'load',
          );
      }
    };
    const providerKeysChanged = () => {
      generation.current += 1;
      setExposedGeneration(generation.current);
      setBusy(false);
      void refreshProvider();
    };
    window.addEventListener('nix-pet-provider-keys-changed', providerKeysChanged);
    void watch();
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener('nix-pet-provider-keys-changed', providerKeysChanged);
    };
  }, [
    client,
    workspaceId,
    petId,
    rootItemId,
    applyRaw,
    discoverModels,
    reportError,
    refuseNoteScope,
  ]);

  const command = useCallback(
    async (operation: 'send' | 'interrupt' | 'reset' | 'read', input?: PetSendInput) => {
      const controller = lifetime.current;
      const myGeneration = generation.current;
      if (busy || !controller || isAborted(controller.signal)) return false;
      setBusy(true);
      reportError('', null);
      try {
        const result = await client.execute(
          pets.runtime({
            operation,
            workspaceId,
            petId,
            ...(rootItemId ? { rootItemId } : {}),
            ...(operation === 'send' && input
              ? {
                  requestId: requestId.current,
                  text: input.text,
                  model: input.model,
                  workspaceAccess: input.workspaceAccess,
                  ...(rootItemId ? { readOnly: input.readOnly ?? true } : {}),
                  ...ownerTurnContext(),
                  ...(input.workspaceMap ? { workspaceMap: input.workspaceMap } : {}),
                  ...(input.itemId
                    ? { itemId: input.itemId, sharedText: input.sharedText ?? '' }
                    : {}),
                  ...(input.itemIds?.length
                    ? { itemIds: input.itemIds, sharedText: input.sharedText ?? '' }
                    : {}),
                  ...(input.replaceFromMessageId
                    ? { replaceFromMessageId: input.replaceFromMessageId }
                    : {}),
                }
              : {}),
          }),
          { signal: controller.signal },
        );
        if (isAborted(controller.signal) || myGeneration !== generation.current) return false;
        const wasConnected = runtimeRef.current?.status === 'connected';
        applyRaw(result);
        if (operation === 'read' && wasConnected && result.status === 'connected') discoverModels();
        if (operation === 'send') requestId.current = crypto.randomUUID();
        return true;
      } catch (cause) {
        if (
          !isCanceledError(cause) &&
          !isAborted(controller.signal) &&
          myGeneration === generation.current
        ) {
          if (rootItemId && isNixApiError(cause) && [403, 404, 409].includes(cause.status ?? 0)) {
            refuseNoteScope();
            return false;
          }
          const detail =
            isNixApiError(cause) && cause.kind === 'problem' && cause.code.startsWith('pets.')
              ? cause.detail?.trim()
              : undefined;
          reportError(
            detail
              ? `${detail}${operation === 'send' ? ' Your draft is preserved.' : ''}`
              : operation === 'send'
                ? 'The request could not be confirmed. Try again; your draft is preserved.'
                : 'The request could not be confirmed. Try again.',
            operation === 'send' ? 'send' : 'command',
          );
        }
        return false;
      } finally {
        if (!isAborted(controller.signal) && myGeneration === generation.current) setBusy(false);
      }
    },
    [
      busy,
      client,
      workspaceId,
      petId,
      rootItemId,
      applyRaw,
      discoverModels,
      reportError,
      refuseNoteScope,
    ],
  );

  return {
    runtime,
    models,
    error,
    errorKind,
    busy,
    setRuntime,
    regenerateRequestId: () => {
      requestId.current = crypto.randomUUID();
    },
    send: (input) => command('send', input),
    interrupt: async () => {
      await command('interrupt');
    },
    reset: async () => {
      await command('reset');
    },
    reload: async () => {
      await command('read');
    },
    retryWatch: () => {
      wake.current.dispatchEvent(new Event('wake'));
    },
  };
}
