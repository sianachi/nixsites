import { type NixClient } from '@nix/api-client';
import { useRef } from 'react';
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
  workspaceAccess,
  hasNoteScope,
  messages,
  contextFields,
  onSent,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly runtimeApi: UsePetRuntimeResult;
  readonly petName: string;
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly model: string;
  readonly workspaceAccess: boolean;
  readonly hasNoteScope: boolean;
  readonly messages: readonly Message[];
  readonly contextFields: () => object;
  /** Called when a turn starts, so a message being edited closes. */
  readonly onSent: () => void;
}): {
  readonly submit: () => Promise<void>;
  readonly resendTurn: (text: string, replaceFromMessageId: string) => Promise<boolean>;
  readonly retryLastTurn: () => void;
  readonly retryLabel: () => string | null;
  readonly retryError: () => void;
  readonly loadErrorMessage: string;
} {
  const { runtime, busy, errorKind, regenerateRequestId, send, reload, retryWatch } = runtimeApi;
  const preparing = useRef(false);

  async function submit() {
    if (!draft.trim() || busy || preparing.current || runtime?.status !== 'connected') return;
    // Plan B.2: a conversation's first message carries a map of the workspace's main
    // containers, so the pet can use their ids without listing the tree first. Only with
    // workspace access on: without it the pet has no tools to use the ids with. `preparing`
    // keeps a second press from starting another send while the map is read.
    const firstMessage = !messages.some((message) => message.role === 'user');
    let workspaceMap: Awaited<ReturnType<typeof buildWorkspaceMap>> = undefined;
    if (firstMessage && workspaceAccess && !hasNoteScope) {
      preparing.current = true;
      try {
        workspaceMap = await buildWorkspaceMap(client, workspaceId, new AbortController().signal);
      } finally {
        preparing.current = false;
      }
    }
    onSent();
    const ok = await send({
      text: draft,
      model,
      workspaceAccess,
      ...contextFields(),
      ...(workspaceMap?.length ? { workspaceMap } : {}),
    });
    if (ok) {
      setDraft('');
    }
  }

  /** Sends `text` as a new turn that replaces the user message `replaceFromMessageId` and
   * everything after it, with the conversation's current context. Backs "Try again",
   * "Regenerate" and an edited last message; each is a new request, unlike a failed `send`'s
   * retry, which resends the exact same one. */
  function resendTurn(text: string, replaceFromMessageId: string) {
    onSent();
    regenerateRequestId();
    return send({
      text,
      model,
      workspaceAccess,
      replaceFromMessageId,
      ...contextFields(),
    });
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
    if (errorKind === 'send') void submit();
    else if (errorKind === 'load') retryWatch();
    else if (errorKind === 'command') void reload();
  }
  const loadErrorMessage = `Lost connection to ${petName}. Retrying…`;

  return { submit, resendTurn, retryLastTurn, retryLabel, retryError, loadErrorMessage };
}
