import { Button, Icon, Text } from '@nix/ui';
import { type PetConnection } from '@nix/api-client';
import { FilePlus, Pencil, RefreshCw } from 'lucide-react';
import { memo, type ReactElement } from 'react';
import { type ProgramPiece } from '../../../openui/fence';
import { PetMessageText } from '../../pet-message-text';

function PetMessageRowView({
  message,
  petName,
  workspaceId,
  latest,
  editor,
  onEdit,
  onRegenerate,
  onSave,
  onAsk,
  applyWithoutAsking,
  earlierPieces,
  followsLockedRead,
  noteScope,
}: {
  readonly message: NonNullable<PetConnection['messages']>[number];
  readonly petName: string;
  readonly workspaceId: string;
  readonly latest: boolean;
  /** Replaces the message text while the message is being edited. */
  readonly editor?: ReactElement | undefined;
  /** Quiet icon actions, offered only when the chat is idle: Edit on the last user message,
   * Save as note on a finished reply, Regenerate on the last reply. */
  readonly onEdit?: ((message: { readonly id: string; readonly text: string }) => void) | undefined;
  readonly onRegenerate?: (() => void) | undefined;
  readonly onSave?: ((text: string) => void) | undefined;
  /** A generated-UI button's request to the pet, which goes to the composer rather than out. */
  readonly onAsk?: ((message: string) => void) | undefined;
  readonly applyWithoutAsking: boolean;
  readonly earlierPieces?: readonly ProgramPiece[] | undefined;
  readonly followsLockedRead: boolean;
  readonly noteScope?: { readonly rootItemId: string; readonly readOnly: boolean } | undefined;
}): ReactElement {
  if (message.role === 'system')
    return (
      <div data-pet-latest-message={latest ? '' : undefined} className="flex justify-center">
        <Text variant="caption" tone="muted">
          {message.text}
        </Text>
      </div>
    );
  const fromUser = message.role === 'user';
  // A streaming draft (id contains `:draft:`) is never durable text yet, so it is kept out of
  // the viewport's `aria-live="polite"` announcement (a screen reader would otherwise read it
  // out token by token) and shown with a caret instead.
  const isDraft = message.id.includes(':draft:');
  return (
    <div
      data-pet-latest-message={latest ? '' : undefined}
      data-pet-from-user={fromUser ? '' : undefined}
      // Nit 16: the whole draft row - its sr-only speaker label included - opts out of the
      // viewport's live region while streaming, not only the text itself; otherwise the label
      // alone would still be announced token turn by token as the row keeps re-rendering.
      aria-live={isDraft ? 'off' : undefined}
      className={`flex min-w-0 shrink-0 flex-col gap-1 ${fromUser ? 'items-end' : 'items-start'}`}
    >
      <Text as="span" variant="note" className="sr-only">
        {fromUser ? 'You said' : `${petName} said`}
      </Text>
      <div
        className={
          fromUser
            ? 'min-w-0 max-w-[90%] rounded-lg bg-surface px-3 py-2 @sm:max-w-[85%]'
            : 'min-w-0 w-full'
        }
      >
        {editor ?? (
          <PetMessageText
            text={message.text}
            workspaceId={workspaceId}
            format={fromUser ? 'plain' : 'markdown'}
            streaming={isDraft}
            onAsk={onAsk}
            applyWithoutAsking={applyWithoutAsking}
            earlierPieces={earlierPieces}
            followsLockedRead={followsLockedRead}
            noteScope={noteScope}
            {...(isDraft ? {} : { messageId: message.id })}
          />
        )}
        {isDraft ? (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-0.5 align-middle bg-foreground motion-safe:animate-pulse"
          />
        ) : null}
      </div>
      {onEdit || onSave || onRegenerate ? (
        <div className="flex items-center">
          {onSave ? (
            <IconAction
              label="Save as note"
              icon={FilePlus}
              onClick={() => {
                onSave(message.text);
              }}
            />
          ) : null}
          {onRegenerate ? (
            <IconAction label="Regenerate" icon={RefreshCw} onClick={onRegenerate} />
          ) : null}
          {onEdit ? (
            <IconAction
              label="Edit message"
              icon={Pencil}
              onClick={() => {
                onEdit(message);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  readonly label: string;
  readonly icon: typeof FilePlus;
  readonly onClick: () => void;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      className="w-(--control-md) px-0 any-pointer-coarse:w-(--control-lg)"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon icon={icon} size="sm" />
    </Button>
  );
}

type RowProps = Parameters<typeof PetMessageRowView>[0];

/** The watch delivers new message objects on every update, so rows compare a message by what it
 * says, not by identity; the callbacks and the rest are expected to be stable. */
export const PetMessageRow = memo(PetMessageRowView, (a: RowProps, b: RowProps) => {
  if (a.message.id !== b.message.id || a.message.text !== b.message.text) return false;
  if (a.message.role !== b.message.role) return false;
  return (Object.keys(a) as (keyof RowProps)[]).every(
    (key) => key === 'message' || Object.is(a[key], b[key]),
  );
});
