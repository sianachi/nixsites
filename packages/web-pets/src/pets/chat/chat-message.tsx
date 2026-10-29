import { type ConversationMessage } from '@nix/api-client';
import { Button, Icon, Text } from '@nix/ui';
import { FilePlus } from 'lucide-react';
import { type ReactNode } from 'react';
import { type ProgramPiece } from '../../openui/fence';
import { PetMessageText } from '../pet-message-text';

/** One saved message, laid out like the live chat: your words in a bubble on the right, the pet's
 * reply full width, a quiet icon to keep a reply as a note. */
export function ChatMessage({
  message,
  latest,
  workspaceId,
  sourceWorkspaceIds,
  earlierPieces,
  onAsk,
  onSave,
}: {
  readonly message: ConversationMessage;
  readonly latest: boolean;
  readonly workspaceId: string;
  readonly sourceWorkspaceIds: readonly string[];
  readonly earlierPieces: readonly ProgramPiece[] | undefined;
  readonly onAsk: (text: string) => void;
  readonly onSave: (text: string) => void;
}): ReactNode {
  if (message.role === 'system')
    return (
      <div data-pet-latest-message={latest ? '' : undefined} className="flex justify-center">
        <Text variant="caption" tone="muted">
          {message.text}
        </Text>
      </div>
    );
  const fromUser = message.role === 'user';
  return (
    <article
      data-pet-latest-message={latest ? '' : undefined}
      data-pet-from-user={fromUser ? '' : undefined}
      className={`flex min-w-0 shrink-0 flex-col gap-1 ${fromUser ? 'items-end' : 'items-start'}`}
    >
      <Text as="span" variant="note" className="sr-only">
        {fromUser ? 'You said' : 'Pet said'}
      </Text>
      <div
        className={
          fromUser
            ? 'min-w-0 max-w-[90%] rounded-lg bg-surface px-3 py-2 @sm:max-w-[85%]'
            : 'min-w-0 w-full'
        }
      >
        <PetMessageText
          text={message.text}
          workspaceId={workspaceId}
          sourceWorkspaceIds={sourceWorkspaceIds}
          // Only the pet's own replies draw components: a chat note is shared, and a
          // member's message must never run as UI in another member's session.
          format={fromUser ? 'plain' : 'markdown'}
          // A chat note is a read-only analysis conversation: its components only read.
          readOnly
          // Filled in, never sent: the owner reads a component's request first.
          onAsk={onAsk}
          messageId={message.id}
          earlierPieces={earlierPieces}
        />
      </div>
      {message.role === 'assistant' ? (
        <Button
          variant="ghost"
          className="w-(--control-md) px-0 any-pointer-coarse:w-(--control-lg)"
          aria-label="Save insight as note"
          title="Save insight as note"
          onClick={() => {
            onSave(message.text);
          }}
        >
          <Icon icon={FilePlus} size="sm" />
        </Button>
      ) : null}
    </article>
  );
}
