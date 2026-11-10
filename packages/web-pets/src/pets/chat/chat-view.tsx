import { ZenPresentationContext } from '@nix/web-foundation/layout/zen-presentation';
import { NewChatNote } from './new-chat-note';
import { ChatMessage } from './chat-message';
import { SaveInsightNote, type SavedInsight } from './save-insight-note';
import {
  isNixApiError,
  conversations,
  items,
  type Conversation,
  type ConversationMessage,
} from '@nix/api-client';
import { Button, Text, Textarea, Checkbox, useUndo } from '@nix/ui';
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { PetChatViewport } from '../pet-chat-viewport';
import { PetMessageText } from '../pet-message-text';
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
  const presentation = useContext(ZenPresentationContext);
  const client = useApiClient();
  const { workspaces } = useAccessibleWorkspaces();
  const [needsSetup, setNeedsSetup] = useState(false);
  const undo = useUndo();
  // The reply being kept as a note (its form opens under it), and what was already kept.
  const [insight, setInsight] = useState<ConversationMessage | null>(null);
  const [saved, setSaved] = useState<Readonly<Record<string, SavedInsight>>>({});
  const [chat, setChat] = useState<Conversation | null>(null);
  const compact =
    presentation?.collectionTools === false || (presentation !== null && chat?.canEdit === false);
  const [messages, setMessages] = useState<readonly ConversationMessage[]>([]);
  // Each message's view of the generated-UI blocks before it, so a patch can find what it changes.
  const piecesBefore = useMemo(() => earlierPieces(messages), [messages]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingSources, setEditingSources] = useState(false);
  // null: the checklist shows the chat's current sources.
  const [sources, setSources] = useState<readonly string[] | null>(null);
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
        setSources(null);
        setInsight(null);
        setSaved({});
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
    if (!draft.trim() || running || busy) return;
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
  const nameOf = (id: string) =>
    workspaces.find((entry) => entry.id === id)?.name ?? 'Unavailable workspace';
  const currentSources = chat
    ? chat.sourceWorkspaceIds.filter((id) =>
        workspaces.some((entry) => entry.id === id && entry.lifecycleState === 'active'),
      )
    : [];
  const checked = sources ?? currentSources;
  function applySources(chosen: readonly string[], previous: readonly string[], revision: number) {
    setBusy(true);
    void client
      .execute(conversations.sources(itemId, chosen, revision), {
        signal: lifetime.current?.signal,
      })
      .then((value) => {
        setChat(value);
        setEditingSources(false);
        setSources(null);
        undo.push(`Sources changed to ${chosen.map(nameOf).join(', ')}`, async () => {
          // Re-read the revision: replies or other edits may have moved it since.
          const latest = await client.query(conversations.conversation(itemId), {
            forceRefresh: true,
          });
          setChat(await client.execute(conversations.sources(itemId, previous, latest.revision)));
        });
      })
      .catch(() => {
        setError('Sources could not be changed. Reload and try again.');
      })
      .finally(() => {
        setBusy(false);
      });
  }
  function keepAsNote(info: SavedInsight, messageId: string) {
    setInsight(null);
    setSaved((previous) => ({ ...previous, [messageId]: info }));
    undo.push(`Saved “${info.title}” to ${info.workspaceName}`, async () => {
      await client.execute(items.deleteItem(info.workspaceId, info.itemId));
      setSaved((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== messageId)),
      );
    });
  }
  function questionBefore(index: number): string {
    for (let at = index - 1; at >= 0; at--)
      if (messages[at]?.role === 'user') return messages[at]?.text ?? '';
    return '';
  }
  return (
    <section aria-label="Chat note" className="@container flex h-full min-h-0 flex-col gap-2">
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
          <div
            className={`mx-auto flex w-full max-w-5xl min-h-0 flex-1 flex-col gap-2 ${compact ? '' : '@5xl:flex-row @5xl:gap-6'}`}
          >
            <div
              className={`flex min-w-0 flex-col gap-2 ${compact ? '' : '@5xl:w-64 @5xl:shrink-0'}`}
            >
              <div
                className={`flex min-w-0 items-center gap-2 px-3 @sm:px-4 ${compact ? '' : '@5xl:hidden'}`}
              >
                <Text variant="note" tone="muted" className="min-w-0 flex-1 truncate">
                  Sources: {chat.sourceWorkspaceIds.map(nameOf).join(', ')}
                </Text>
                {chat.canEdit ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    aria-expanded={editingSources}
                    onClick={() => {
                      setSources(null);
                      setEditingSources(!editingSources);
                    }}
                  >
                    Change sources
                  </Button>
                ) : null}
              </div>
              {chat.canEdit ? (
                <fieldset
                  aria-label="Pet answers from"
                  className={`${editingSources ? 'flex' : compact ? 'hidden' : 'hidden @5xl:flex'} flex-col gap-2 px-3 @sm:px-4 ${compact ? '' : '@5xl:px-0'}`}
                >
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
                        checked={checked.includes(entry.id)}
                        onChange={(event) => {
                          setSources(
                            event.currentTarget.checked
                              ? [...checked, entry.id]
                              : checked.filter((id) => id !== entry.id),
                          );
                        }}
                      />
                    ))}
                  <Text variant="note" tone="muted">
                    {running ? 'Applies to your next question.' : 'Your pet reads these only.'}
                  </Text>
                  <Button
                    disabled={
                      busy ||
                      !checked.length ||
                      (checked.length === currentSources.length &&
                        checked.every((id) => currentSources.includes(id)))
                    }
                    onClick={() => {
                      applySources(checked, chat.sourceWorkspaceIds, chat.revision);
                    }}
                  >
                    Apply sources
                  </Button>
                </fieldset>
              ) : null}
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
              <PetChatViewport
                // Not the streamed length: the reply grows in place and the viewport must not re-anchor per token.
                latestKey={`${messages.at(-1)?.id ?? ''}:${String(streaming)}`}
              >
                {messages.map((message, index) => {
                  const kept = saved[message.id];
                  return (
                    <ChatMessage
                      key={message.id}
                      message={message}
                      latest={index === messages.length - 1 && !streaming}
                      workspaceId={workspaceId}
                      sourceWorkspaceIds={chat.sourceWorkspaceIds}
                      earlierPieces={piecesBefore[index]}
                      onAsk={setDraft}
                      onSave={() => {
                        setInsight(insight?.id === message.id ? null : message);
                      }}
                      sourceNames={(message.sourceWorkspaceIds ?? []).map(nameOf)}
                      saved={
                        kept
                          ? {
                              href: `/w/${kept.workspaceId}?item=${kept.itemId}`,
                              workspaceName: kept.workspaceName,
                            }
                          : undefined
                      }
                      below={
                        insight?.id === message.id ? (
                          <SaveInsightNote
                            text={message.text}
                            initialTitle={
                              questionBefore(index).replace(/\s+/g, ' ').trim().slice(0, 80) ||
                              'Conversation insight'
                            }
                            initialWorkspaceId={workspaceId}
                            onSaved={(info) => {
                              keepAsNote(info, message.id);
                            }}
                            onClose={() => {
                              setInsight(null);
                            }}
                          />
                        ) : undefined
                      }
                    />
                  );
                })}
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
                    A reply is in progress, answering from {currentSources.map(nameOf).join(', ')}…
                  </Text>
                  {chat.canSend ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void client
                          .execute(conversations.cancel(itemId), {
                            signal: lifetime.current?.signal,
                          })
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
                    onChange={(event) => {
                      pending.current = null;
                      setDraft(event.currentTarget.value);
                    }}
                    onKeyDown={(event) => {
                      // Ctrl or Cmd with Enter always sends; plain Enter sends only with a mouse and
                      // keyboard (a phone has no Shift, so there it stays a newline).
                      if (
                        event.key === 'Enter' &&
                        !event.nativeEvent.isComposing &&
                        (event.metaKey ||
                          event.ctrlKey ||
                          (!event.shiftKey && window.matchMedia('(pointer: fine)').matches))
                      ) {
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
                  Sending is unavailable. An editor can check source access and the pet connection,
                  or update the sources.
                </Text>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
