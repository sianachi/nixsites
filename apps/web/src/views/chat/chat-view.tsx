import { NewChatNote } from './new-chat-note';
import { ChatMessage } from './chat-message';
import { SaveInsightNote } from './save-insight-note';
import {
  isNixApiError,
  conversations,
  type Conversation,
  type ConversationMessage,
} from '@nix/api-client';
import { Button, Text, Textarea, Checkbox } from '@nix/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PetChatViewport } from '../../pets/pet-chat-viewport';
import { PetMessageText } from '../../pets/pet-message-text';
import { earlierPieces } from '../../openui/fence';
import { useAccessibleWorkspaces } from '@nix/web-workspaces/workspaces/workspace-context';
import { isAborted } from '@nix/web-foundation/lib/guards';

export function ChatView({
  itemId,
  workspaceId,
}: {
  readonly itemId: string;
  readonly workspaceId: string;
}): ReactNode {
  const client = useApiClient();
  const { workspaces } = useAccessibleWorkspaces();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [insight, setInsight] = useState<string | null>(null);
  const [chat, setChat] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  // Each message's view of the generated-UI blocks before it, so a patch can find what it changes.
  const piecesBefore = useMemo(() => earlierPieces(messages), [messages]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  const [sources, setSources] = useState<readonly string[]>([]);
  const lifetime = useRef<AbortController | null>(null);
  const pending = useRef<{ text: string; requestId: string } | null>(null);
  const tail = useRef<string | undefined>(undefined);
  const running = chat?.turn?.status === 'running';
  const streamedText = running ? (chat.turn?.text ?? '') : '';
  const streaming = streamedText !== '';
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    let previousRevision: number | undefined;
    tail.current = undefined;
    queueMicrotask(() => {
      if (!isAborted(controller.signal)) {
        setChat(null);
        setMessages([]);
        setCursor(null);
        setNeedsSetup(false);
        setDraft('');
        setError('');
        setEditingSources(false);
        pending.current = null;
      }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const value = await client.query(conversations.conversation(itemId), {
          signal: controller.signal,
          forceRefresh: true,
        });
        if (isAborted(controller.signal)) return;
        setChat(value);
        if (previousRevision !== value.revision) {
          const page = await client.query(
            conversations.messages(itemId, tail.current ? { cursor: tail.current } : {}),
            { signal: controller.signal, forceRefresh: true },
          );
          if (isAborted(controller.signal)) return;
          const last = page.items.at(-1);
          if (last) tail.current = last.seq;
          setMessages((previous) => [
            ...previous.filter((existing) => !page.items.some((entry) => entry.id === existing.id)),
            ...page.items,
          ]);
          setCursor(page.nextCursor);
          previousRevision = value.revision;
        }
        setError('');
      } catch (cause) {
        if (isNixApiError(cause) && cause.status === 404 && !isAborted(controller.signal))
          setNeedsSetup(true);
        if (!isAborted(controller.signal)) setError('The conversation could not be loaded.');
      } finally {
        if (!isAborted(controller.signal)) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, itemId]);
  async function send() {
    if (!draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const text = draft.trim();
      const request =
        pending.current?.text === text ? pending.current : { text, requestId: crypto.randomUUID() };
      pending.current = request;
      setChat(
        await client.execute(conversations.send(itemId, request), {
          signal: lifetime.current?.signal,
        }),
      );
      pending.current = null;
      setDraft('');
    } catch {
      setError('The message could not be sent. Check source access and your pet connection.');
    } finally {
      setBusy(false);
    }
  }
  async function more() {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await client.query(conversations.messages(itemId, { cursor }), {
        forceRefresh: true,
        signal: lifetime.current?.signal,
      });
      const last = page.items.at(-1);
      if (last) tail.current = last.seq;
      setMessages((previous) => [
        ...previous,
        ...page.items.filter((entry) => !previous.some((existing) => existing.id === entry.id)),
      ]);
      setCursor(page.nextCursor);
    } catch {
      setError('More messages could not be loaded.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Chat note" className="@container flex h-full min-h-0 flex-col gap-2">
      {insight !== null ? (
        <SaveInsightNote
          text={insight}
          onClose={() => {
            setInsight(null);
          }}
        />
      ) : null}
      {needsSetup ? (
        <NewChatNote
          existingItemId={itemId}
          sourceWorkspaceIds={[workspaceId]}
          onClose={() => {
            setNeedsSetup(false);
          }}
        />
      ) : null}
      {error ? <Text role="alert">{error}</Text> : null}
      {!chat ? (
        <Text role="status">Loading conversation…</Text>
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-2xl min-w-0 items-center gap-2 px-3 @sm:px-4">
            <Text variant="note" tone="muted" className="min-w-0 flex-1 truncate">
              Sources:{' '}
              {chat.sourceWorkspaceIds
                .map(
                  (id) =>
                    workspaces.find((entry) => entry.id === id)?.name ?? 'Unavailable workspace',
                )
                .join(', ')}
            </Text>
            {chat.canEdit ? (
              <Button
                variant="ghost"
                disabled={running || busy}
                onClick={() => {
                  setSources(
                    chat.sourceWorkspaceIds.filter((id) =>
                      workspaces.some(
                        (entry) => entry.id === id && entry.lifecycleState === 'active',
                      ),
                    ),
                  );
                  setEditingSources(!editingSources);
                }}
              >
                Change sources
              </Button>
            ) : null}
          </div>
          {editingSources ? (
            <fieldset className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-3 @sm:px-4">
              <legend>
                <Text as="span" variant="h5">
                  Sources for future turns
                </Text>
              </legend>
              {workspaces
                .filter((entry) => entry.lifecycleState === 'active')
                .map((entry) => (
                  <Checkbox
                    key={entry.id}
                    label={entry.name}
                    checked={sources.includes(entry.id)}
                    onChange={(event) => {
                      setSources(
                        event.currentTarget.checked
                          ? [...sources, entry.id]
                          : sources.filter((id) => id !== entry.id),
                      );
                    }}
                  />
                ))}
              <Button
                disabled={busy || !sources.length}
                onClick={() => {
                  setBusy(true);
                  void client
                    .execute(conversations.sources(itemId, sources, chat.revision), {
                      signal: lifetime.current?.signal,
                    })
                    .then((value) => {
                      setChat(value);
                      setEditingSources(false);
                    })
                    .catch(() => {
                      setError('Sources could not be changed. Reload and try again.');
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                Save sources
              </Button>
            </fieldset>
          ) : null}
          <PetChatViewport
            // Not the streamed length: the reply grows in place and the viewport must not re-anchor per token.
            latestKey={`${messages.at(-1)?.id ?? ''}:${String(streaming)}`}
          >
            {messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                latest={index === messages.length - 1 && !streaming}
                workspaceId={workspaceId}
                sourceWorkspaceIds={chat.sourceWorkspaceIds}
                earlierPieces={piecesBefore[index]}
                onAsk={setDraft}
                onSave={setInsight}
              />
            ))}
            {!messages.length ? (
              <Text tone="muted">Ask a question about your selected workspaces.</Text>
            ) : null}
            {cursor ? (
              <Button variant="secondary" disabled={busy} onClick={() => void more()}>
                Load more messages
              </Button>
            ) : null}
            {streaming ? (
              <article data-pet-latest-message="" aria-live="off">
                <PetMessageText
                  text={streamedText}
                  workspaceId={workspaceId}
                  sourceWorkspaceIds={chat.sourceWorkspaceIds}
                  streaming
                  readOnly
                  earlierPieces={piecesBefore.at(-1)}
                />
              </article>
            ) : null}
          </PetChatViewport>
          {chat.turn?.error ? <Text role="alert">{chat.turn.error}</Text> : null}
          {running ? (
            <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-3 @sm:px-4">
              <Text role="status" tone="muted" className="flex-1">
                A reply is in progress…
              </Text>
              {chat.canSend ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    void client
                      .execute(conversations.cancel(itemId), { signal: lifetime.current?.signal })
                      .then(setChat)
                      .catch(() => {
                        setError('The reply could not be cancelled.');
                      })
                  }
                >
                  Stop reply
                </Button>
              ) : null}
            </div>
          ) : null}
          {chat.canSend ? (
            <form
              className="mx-auto flex w-full max-w-2xl items-end gap-2 p-3 @sm:p-4"
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <Textarea
                aria-label="Message"
                value={draft}
                maxLength={8000}
                disabled={busy || running}
                onChange={(event) => {
                  pending.current = null;
                  setDraft(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  // Enter stays a newline (a phone has no Shift); Ctrl or Cmd with Enter sends.
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <Button type="submit" disabled={busy || running || !draft.trim()}>
                Send
              </Button>
            </form>
          ) : (
            <Text
              role="status"
              tone="muted"
              className="mx-auto w-full max-w-2xl px-3 pb-3 @sm:px-4"
            >
              Sending is unavailable. An editor can check source access and the pet connection, or
              update the sources.
            </Text>
          )}
        </>
      )}
    </section>
  );
}
