import { memoryModeOf } from '../../memory-mode';
import { type PetConnection, type PetProfile, type PetSettings } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { Fragment, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import { type NixClient } from '@nix/api-client';
import { type ProgramPiece } from '../../../openui/fence';
import { PetAvatar } from '../../pet-avatar';
import { PetChatViewport } from '../../pet-chat-viewport';
import { PetWorkTools } from '../../work-tools/pet-work-tools';
import { type ConversationJobEntry } from '../conversation-jobs';
import { PetEmptyState } from './empty-state';
import { PetMessageEditor } from './message-editor';
import { PetMessageRow } from './message-row';
import { toolInsertIndex } from './tool-insert-index';

type Message = NonNullable<PetConnection['messages']>[number];

export function MessageList({
  client,
  workspaceId,
  pet,
  settings,
  runtime,
  messages,
  piecesBefore,
  running,
  busy,
  hasDraft,
  approvalPending,
  workspaceAccess,
  suggestions,
  onPick,
  onAsk,
  setRuntime,
  reportNeedsDecision,
  applyWithoutAsking,
  applyExemptToolIds,
  noteScope,
  editing,
  setEditing,
  enterToSend,
  resendTurn,
  retryLastTurn,
  onSaveInsight,
  jobEntries,
  onAttachToJob,
}: {
  readonly client: NixClient;
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
  readonly runtime: PetConnection;
  readonly messages: readonly Message[];
  readonly piecesBefore: readonly (readonly ProgramPiece[] | undefined)[];
  readonly running: boolean;
  readonly busy: boolean;
  readonly hasDraft: boolean;
  readonly approvalPending: boolean;
  readonly workspaceAccess: boolean;
  readonly suggestions: readonly string[];
  readonly onPick: (suggestion: string) => void;
  readonly onAsk: (text: string) => void;
  readonly setRuntime: (runtime: PetConnection) => void;
  readonly reportNeedsDecision: (toolIds: readonly string[]) => void;
  readonly applyWithoutAsking: boolean;
  readonly applyExemptToolIds: readonly string[];
  readonly noteScope:
    { readonly rootItemId: string; readonly title: string; readonly readOnly: boolean } | undefined;
  readonly editing: { readonly id: string; readonly text: string } | null;
  readonly setEditing: (value: { readonly id: string; readonly text: string } | null) => void;
  readonly enterToSend: boolean;
  readonly resendTurn: (text: string, replaceFromMessageId: string) => unknown;
  readonly retryLastTurn: () => void;
  readonly onSaveInsight: (text: string) => void;
  readonly jobEntries?: readonly ConversationJobEntry[] | undefined;
  readonly onAttachToJob?: ((text: string) => void) | undefined;
}): ReactElement {
  // The watch hands over a new runtime up to four times a second. Rows are memoised, so the
  // callbacks they receive must keep one identity; they read the latest props through a ref.
  const latestProps = useRef({ onAsk, retryLastTurn, onSaveInsight, setEditing, onAttachToJob });
  useLayoutEffect(() => {
    latestProps.current = { onAsk, retryLastTurn, onSaveInsight, setEditing, onAttachToJob };
  });
  const stable = useMemo(
    () => ({
      onAsk: (text: string) => {
        latestProps.current.onAsk(text);
      },
      onRegenerate: () => {
        latestProps.current.retryLastTurn();
      },
      onSave: (text: string) => {
        latestProps.current.onSaveInsight(text);
      },
      onEdit: (message: { readonly id: string; readonly text: string }) => {
        latestProps.current.setEditing({ id: message.id, text: message.text });
      },
      onAttach: (text: string) => {
        latestProps.current.onAttachToJob?.(text);
      },
    }),
    [],
  );
  const entriesByMessage = new Map<string, ConversationJobEntry[]>();
  const messageIds = new Set(messages.map((message) => message.id));
  const detachedEntries: ConversationJobEntry[] = [];
  for (const entry of jobEntries ?? []) {
    const anchor = entry.afterMessageId;
    if (anchor === undefined || !messageIds.has(anchor)) {
      detachedEntries.push(entry);
      continue;
    }
    const anchored = entriesByMessage.get(anchor) ?? [];
    anchored.push(entry);
    entriesByMessage.set(anchor, anchored);
  }

  const newestJob = jobEntries?.at(-1);
  const latestJobId =
    !running && !busy && newestJob?.afterMessageId === messages.at(-1)?.id
      ? newestJob?.id
      : undefined;
  const renderEntry = (entry: ConversationJobEntry) => (
    <div
      key={entry.id}
      data-pet-latest-message={entry.id === latestJobId ? '' : undefined}
      className="min-w-0"
    >
      {entry.content}
    </div>
  );

  const tools = (
    <PetWorkTools
      client={client}
      runtime={runtime}
      workspaceId={workspaceId}
      petId={pet.id}
      petName={pet.name}
      onChange={setRuntime}
      onNeedsDecisionChange={reportNeedsDecision}
      applyWithoutAsking={applyWithoutAsking}
      applyExemptToolIds={applyExemptToolIds}
      noteScope={noteScope}
      memoryMode={memoryModeOf(settings)}
    />
  );
  return (
    <PetChatViewport
      quiet
      latestKey={`${messages.at(-1)?.id ?? ''}:${runtime.tools?.at(-1)?.id ?? ''}:${running ? 'thinking' : 'idle'}:${approvalPending ? 'approval' : ''}:${jobEntries?.at(-1)?.id ?? ''}`}
    >
      {messages.length === 0 ? (
        <>
          {detachedEntries.length === 0 ? (
            <PetEmptyState
              pet={pet}
              workspaceAccess={workspaceAccess}
              suggestions={suggestions}
              onPick={onPick}
            />
          ) : null}
          {tools}
        </>
      ) : (
        (() => {
          const splitAt = toolInsertIndex(messages);
          // Only the last turn can be redone: its user message and the reply after it.
          const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
          const lastReplyIndex = messages.findIndex(
            (message, index) =>
              index > lastUserIndex &&
              message.id === `${messages[lastUserIndex]?.id ?? ''}:assistant`,
          );
          const idle = !running && !busy;
          const row = (message: Message, index: number) => {
            const edit = editing?.id === message.id ? editing : null;
            const quiet = !idle || edit !== null;
            return (
              <Fragment key={message.id}>
                <PetMessageRow
                  message={message}
                  petName={pet.name}
                  workspaceId={workspaceId}
                  // While a card waits it is the scroll anchor; your own message still wins (it is yours).
                  latest={
                    latestJobId === undefined &&
                    index === messages.length - 1 &&
                    (!approvalPending || message.role === 'user')
                  }
                  onAsk={stable.onAsk}
                  applyWithoutAsking={applyWithoutAsking}
                  earlierPieces={piecesBefore[index]}
                  followsLockedRead={runtime.lockedRead}
                  noteScope={noteScope}
                  editor={
                    edit ? (
                      <PetMessageEditor
                        text={edit.text}
                        enterToSend={enterToSend}
                        busy={running || busy}
                        onChange={(text) => {
                          setEditing({ id: message.id, text });
                        }}
                        onSend={() => {
                          setEditing(null);
                          void resendTurn(edit.text, message.id);
                        }}
                        onCancel={() => {
                          setEditing(null);
                        }}
                      />
                    ) : undefined
                  }
                  onEdit={!quiet && index === lastUserIndex ? stable.onEdit : undefined}
                  onRegenerate={
                    !quiet && index === lastReplyIndex ? stable.onRegenerate : undefined
                  }
                  onAttachToJob={
                    !quiet &&
                    !runtime.lockedRead &&
                    !message.id.includes(':draft:') &&
                    onAttachToJob
                      ? stable.onAttach
                      : undefined
                  }
                  onSave={
                    !quiet && message.role === 'assistant' && !message.id.includes(':draft:')
                      ? stable.onSave
                      : undefined
                  }
                />
                {entriesByMessage.get(message.id)?.map(renderEntry)}
              </Fragment>
            );
          };
          return (
            <>
              {messages.slice(0, splitAt).map((message, index) => row(message, index))}
              {tools}
              {messages.slice(splitAt).map((message, offset) => row(message, splitAt + offset))}
            </>
          );
        })()
      )}
      {detachedEntries.map(renderEntry)}
      {runtime.state === 'error' ? (
        // At the turn that failed, after the last row, where the reply would have been.
        <div className="flex items-center justify-between gap-2">
          <Text role="alert">{runtime.reason || 'The response did not finish. Try again.'}</Text>
          <Button variant="ghost" onClick={retryLastTurn}>
            Try again
          </Button>
        </div>
      ) : null}
      {running && !hasDraft && !approvalPending ? (
        // The pet itself, in its thinking pose: the avatar owns the motion preference and
        // shows a still frame under reduced motion. The header status carries the label.
        <div className="flex items-center gap-2" aria-hidden="true">
          <PetAvatar
            appearance={pet.appearance}
            state="thinking"
            label={`${pet.name}: thinking`}
            size="compact"
          />
          <Text variant="note" tone="muted">
            {pet.name} is thinking
          </Text>
        </div>
      ) : null}
    </PetChatViewport>
  );
}
