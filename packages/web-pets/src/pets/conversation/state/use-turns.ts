import { type NixClient } from '@nix/api-client';
import { useRef, useState } from 'react';
import { buildWorkspaceMap } from '../../turn-context';
import { type UsePetRuntimeResult } from '../../use-pet-runtime';

type Message = NonNullable<NonNullable<UsePetRuntimeResult['runtime']>['messages']>[number];

/** Sending, resending and retrying turns, and the retry offered for a hook-level error. */
export function useTurns({
  client,
  workspaceId,
  runtimeApi,
  petName,
  draft,
  setDraft,
  model,
  thinkHarder = false,
  workspaceAccess,
  hasNoteScope,
  messages,
  contextFields,
  onSent,
  consentMode,
  onAccepted,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly runtimeApi: UsePetRuntimeResult;
  readonly petName: string;
  readonly draft: string;
  readonly setDraft: (value: string | ((current: string) => string)) => void;
  readonly model: string;
  /** Send this message on the provider's larger model. */
  readonly thinkHarder?: boolean;
  readonly workspaceAccess: boolean;
  readonly hasNoteScope: boolean;
  readonly messages: readonly Message[];
  readonly contextFields: () => object;
  /** Called when a turn starts, so a message being edited closes. */
  readonly onSent: (replacement?: { readonly id: string; readonly text: string }) => void;
  readonly consentMode?: 'plan' | undefined;
  readonly onAccepted?:
    ((scope: { readonly workspaceAccess: boolean; readonly context: object }) => void) | undefined;
}): {
  readonly submit: (
    creationRequest?: string,
    onStarted?: () => void,
    creationRequestId?: string,
  ) => Promise<boolean>;
  readonly resendTurn: (text: string, replaceFromMessageId: string) => Promise<boolean>;
  readonly retryLastTurn: () => void;
  readonly retryLabel: () => string | null;
  readonly retryError: () => void;
  readonly loadErrorMessage: string;
  readonly preparing: boolean;
} {
  const { runtime, busy, errorKind, regenerateRequestId, send, reload, retryWatch } = runtimeApi;
  const preparationPending = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const lastCreation = useRef<string | undefined>(undefined);

  async function submit(
    creationRequest?: string,
    onStarted?: () => void,
    creationRequestId?: string,
  ) {
    const text = creationRequest ?? draft;
    if (!text.trim() || busy || preparationPending.current || runtime?.status !== 'connected')
      return false;
    const access = workspaceAccess || creationRequest !== undefined;
    lastCreation.current = creationRequest;
    const context = creationRequest === undefined ? contextFields() : {};
    if (onStarted !== undefined && creationRequestId === undefined) regenerateRequestId();
    // Plan B.2: a conversation's first message carries a map of the workspace's main
    // containers, so the pet can use their ids without listing the tree first. Only with
    // workspace access on: without it the pet has no tools to use the ids with. The ref
    // keeps a second press from starting another send while the map is read.
    const firstMessage = !messages.some((message) => message.role === 'user');
    let workspaceMap: Awaited<ReturnType<typeof buildWorkspaceMap>> = undefined;
    if (firstMessage && access && !hasNoteScope) {
      preparationPending.current = true;
      setPreparing(true);
      try {
        workspaceMap = await buildWorkspaceMap(client, workspaceId, new AbortController().signal);
      } finally {
        preparationPending.current = false;
        setPreparing(false);
      }
    }
    const ok = await send({
      text,
      model,
      ...(thinkHarder ? { thinkHarder } : {}),
      workspaceAccess: access,
      ...(creationRequestId === undefined ? {} : { requestId: creationRequestId }),
      ...(consentMode === undefined ? {} : { consentMode }),
      ...context,
      ...(workspaceMap?.length ? { workspaceMap } : {}),
    });
    if (ok && creationRequest === undefined)
      setDraft((current) => (current === text ? '' : current));
    if (ok) onStarted?.();
    if (ok) onAccepted?.({ workspaceAccess: access, context });
    if (ok) onSent();
    return ok;
  }

  /** Sends `text` as a new turn that replaces the user message `replaceFromMessageId` and
   * everything after it, with the conversation's current context. Backs "Try again",
   * "Regenerate" and an edited last message; each is a new request, unlike a failed `send`'s
   * retry, which resends the exact same one. */
  async function resendTurn(text: string, replaceFromMessageId: string) {
    if (preparationPending.current) return Promise.resolve(false);
    preparationPending.current = true;
    setPreparing(true);
    const creation = text === lastCreation.current;
    const context = creation ? {} : contextFields();
    try {
      regenerateRequestId();
      const accepted = await send({
        text,
        model,
        ...(thinkHarder ? { thinkHarder } : {}),
        workspaceAccess: workspaceAccess || creation,
        ...(consentMode === undefined ? {} : { consentMode }),
        replaceFromMessageId,
        ...context,
      });
      if (accepted) {
        onAccepted?.({ workspaceAccess: workspaceAccess || creation, context });
        onSent({ id: replaceFromMessageId, text });
      }
      return accepted;
    } finally {
      preparationPending.current = false;
      setPreparing(false);
    }
  }

  /** Must-fix 4: a failed turn (the worker reports `state: 'error'`, not a client-side request
   * failure) offers its own "Try again" that resends the *last user message*. */
  function retryLastTurn() {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUser) void resendTurn(lastUser.text, lastUser.id);
  }

  /** Must-fix 4: the label a hook-level `error` offers, keyed by `errorKind` - `send` and
   * `command` both resubmit ("Try again"), `load` wakes the watch loop instead ("Retry now"). */
  function retryLabel(): string | null {
    if (errorKind === 'send' || errorKind === 'command') return 'Try again';
    if (errorKind === 'load') return 'Retry now';
    return null;
  }
  /** The action behind that label - `send` resubmits the same request (the request id stays
   * fixed since a failed `send` never regenerates it), `load` wakes the watch loop, and
   * `command` retries whatever one-off request (interrupt, reset, an explicit reload) failed. */
  function retryError() {
    if (errorKind === 'send') void submit(lastCreation.current);
    else if (errorKind === 'load') retryWatch();
    else if (errorKind === 'command') void reload();
  }
  const loadErrorMessage = runtimeApi.error || `Lost connection to ${petName}. Retrying…`;

  return { submit, resendTurn, retryLastTurn, retryLabel, retryError, loadErrorMessage, preparing };
}
