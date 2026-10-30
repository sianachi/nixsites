import { comments, isNixApiError, type Comment, type CommentThread } from '@nix/api-client';
import { Button, Icon, Input, Menu, Text, Textarea, focusRing } from '@nix/ui';
import {
  AtSign,
  Check,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  SendHorizontal,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  openThreadCard,
  patchComments,
  readComments,
  type CapturedAnchor,
} from '@nix/web-editor/editor/comment-anchors';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';

/**
 * The comment thread card, its composer and the mention picker, shared by the comments pane (an
 * overview list) and the card that opens at the text in the editor, so a thread looks and acts the
 * same in both. It lives in apps/web because the mention picker needs the workspace packages,
 * which the editor package may not import.
 */

export const ERRORS: Readonly<Record<string, string>> = {
  'comments.forbidden': 'You do not have permission to comment on this note.',
  'comments.not_author': 'Only the author can change this comment.',
  'comments.limit': 'This note has reached its comment limit.',
  'items.locked': 'This note is locked.',
};

export function refusalText(reason: unknown): string {
  if (isNixApiError(reason)) {
    const known = ERRORS[reason.code];
    if (known !== undefined) return known;
    if (reason.status === 409) return 'This note is in the trash.';
    return reason.detail ?? 'That did not work. Try again.';
  }
  return 'Core could not be reached.';
}

function authorLabel(comment: Comment): string {
  return comment.importedAuthor === null
    ? comment.authorName
    : `by ${comment.importedAuthor} (imported)`;
}

/**
 * One note's comment writes: runs each, then re-reads the list. A refusal is kept in `problem`
 * for the surface to show in words.
 */
export function useCommentWrites(itemId: string): {
  readonly problem: string | null;
  readonly act: (write: () => Promise<unknown>) => Promise<boolean>;
  readonly addThread: (
    body: string,
    mentionIds: readonly string[],
    anchor: CapturedAnchor | null,
  ) => Promise<boolean>;
} {
  const client = useApiClient();
  const [problem, setProblem] = useState<string | null>(null);

  async function act(write: () => Promise<unknown>): Promise<boolean> {
    setProblem(null);
    try {
      await write();
      readComments(itemId).refresh();
      return true;
    } catch (reason) {
      setProblem(refusalText(reason));
      return false;
    }
  }

  const addThread = (
    body: string,
    mentionIds: readonly string[],
    anchor: CapturedAnchor | null,
  ): Promise<boolean> =>
    act(async () => {
      const created = await client.execute(
        comments.add(itemId, { body, mentionIds, ...(anchor === null ? {} : { anchor }) }),
      );
      // The new thread's card opens at the text it was made on; the thread is added now so the
      // card does not take it for a missing one while the refresh below is on its way.
      patchComments(itemId, {
        threads: [...readComments(itemId).threads.filter((t) => t.id !== created.id), created],
        draft: null,
        card: { kind: 'thread', threadId: created.id },
        activeThreadId: created.id,
      });
    });

  return { problem, act, addThread };
}

/** A quiet icon-only button for card headers and row menus. */
export function CardIconButton({
  label,
  icon,
  onClick,
  className = '',
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly className?: string;
}): ReactNode {
  return (
    <Button
      variant="subtle"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`px-2 pointer-coarse:min-h-(--control-lg) pointer-coarse:min-w-(--control-lg) ${className}`}
    >
      <Icon icon={icon} size="sm" />
    </Button>
  );
}

export function ThreadCard({
  itemId,
  thread,
  me,
  active,
  detached,
  canComment,
  act,
  inline = false,
  onClose,
}: {
  /** Shown at the text itself, where the quote is already highlighted behind the card. */
  readonly inline?: boolean;
  /** The card's own close control, drawn beside Resolve in the first comment's row. */
  readonly onClose?: (() => void) | undefined;
  readonly itemId: string;
  readonly thread: CommentThread;
  readonly me: string | null;
  readonly active: boolean;
  readonly detached: boolean;
  readonly canComment: boolean;
  readonly act: (write: () => Promise<unknown>) => Promise<boolean>;
}): ReactNode {
  const client = useApiClient();
  const isResolved = thread.resolvedAt !== null;
  const header = (
    <>
      {canComment ? (
        <CardIconButton
          label={isResolved ? 'Reopen' : 'Resolve'}
          icon={isResolved ? RotateCcw : Check}
          onClick={() => {
            void act(() => client.execute(comments.setResolved(itemId, thread.id, !isResolved)));
          }}
        />
      ) : null}
      {onClose === undefined ? null : <CardIconButton label="Close" icon={X} onClick={onClose} />}
    </>
  );

  return (
    <article
      aria-label={`Comment thread${thread.quote === null ? '' : ` on ${thread.quote}`}`}
      className={`flex flex-col gap-3 ${
        inline ? '' : `rounded-sm border p-2 ${active ? 'border-accent' : 'border-divider'}`
      }`}
    >
      {thread.quote === null || (inline && !detached) ? null : (
        <button
          type="button"
          onClick={() => {
            openThreadCard(itemId, thread.id);
          }}
          className={`rounded-sm border-l-2 border-divider pl-2 text-left text-sm text-muted ${focusRing}`}
        >
          {thread.quote}
        </button>
      )}
      {detached ? (
        <Text variant="caption" tone="muted">
          The text it was on is gone.
        </Text>
      ) : null}

      {thread.comments.map((comment, index) => (
        <CommentRow
          key={comment.id}
          itemId={itemId}
          comment={comment}
          me={me}
          act={act}
          trailing={index === 0 ? header : null}
        />
      ))}

      {isResolved ? (
        <Text variant="caption" tone="muted">
          Resolved{thread.resolvedByName === null ? '' : ` by ${thread.resolvedByName}`}
        </Text>
      ) : null}

      {canComment ? (
        <div className="sticky bottom-0 -mb-1 bg-background pb-1">
          <Composer
            compact
            label="Reply"
            submitLabel="Reply"
            onSubmit={(body, mentionIds) =>
              act(() => client.execute(comments.reply(itemId, thread.id, { body, mentionIds })))
            }
          />
        </div>
      ) : null}
    </article>
  );
}

function CommentRow({
  itemId,
  comment,
  me,
  act,
  trailing,
}: {
  readonly itemId: string;
  readonly comment: Comment;
  readonly me: string | null;
  readonly act: (write: () => Promise<unknown>) => Promise<boolean>;
  readonly trailing: ReactNode;
}): ReactNode {
  const client = useApiClient();
  const [editing, setEditing] = useState(false);
  const mine = me !== null && comment.authorId === me;

  if (comment.deleted) {
    return (
      <div className="flex items-center justify-between gap-2">
        <Text variant="bodySmall" tone="muted">
          Comment deleted
        </Text>
        <div className="-my-1 flex">{trailing}</div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-1">
      <div className="-my-1.5 flex items-center gap-2">
        <Text variant="bodySmall" className="min-w-0 flex-1">
          <span className="font-medium">{authorLabel(comment)}</span>
          <span className="text-muted">
            {' · '}
            {formatRelativeTime(new Date(comment.createdAt))}
            {comment.editedAt === null ? '' : ' (edited)'}
          </span>
        </Text>
        <div className="flex shrink-0">
          {mine && !editing ? (
            <Menu
              label="Comment actions"
              items={[
                {
                  label: 'Edit',
                  icon: Pencil,
                  onSelect: () => {
                    setEditing(true);
                  },
                },
                {
                  label: 'Delete',
                  icon: Trash2,
                  destructive: true,
                  onSelect: () => {
                    void act(() => client.execute(comments.remove(itemId, comment.id)));
                  },
                },
              ]}
            >
              {(trigger) => (
                <Button
                  {...trigger}
                  variant="subtle"
                  aria-label="More actions"
                  className="px-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 pointer-coarse:min-h-(--control-lg) pointer-coarse:min-w-(--control-lg) pointer-coarse:opacity-100"
                >
                  <Icon icon={MoreHorizontal} size="sm" />
                </Button>
              )}
            </Menu>
          ) : null}
          {trailing}
        </div>
      </div>
      {editing ? (
        <Composer
          label="Edit comment"
          submitLabel="Save"
          initial={comment.body}
          onSubmit={async (body) => {
            const saved = await act(() => client.execute(comments.edit(itemId, comment.id, body)));
            if (saved) setEditing(false);
            return saved;
          }}
          onCancel={() => {
            setEditing(false);
          }}
        />
      ) : (
        <Text variant="bodySmall" className="whitespace-pre-wrap">
          {comment.body}
        </Text>
      )}
    </div>
  );
}

/** A text box with an optional mention picker; `onSubmit` answers whether it was sent. */
export function Composer({
  label,
  submitLabel,
  quote = null,
  initial = '',
  compact = false,
  onSubmit,
  onCancel,
}: {
  /** One quiet line that grows as you type, with icon buttons: the reply field of a thread. */
  readonly compact?: boolean;
  readonly label: string;
  readonly submitLabel: string;
  readonly quote?: string | null;
  readonly initial?: string;
  readonly onSubmit: (body: string, mentionIds: readonly string[]) => Promise<boolean>;
  readonly onCancel?: (() => void) | undefined;
}): ReactNode {
  const [body, setBody] = useState(initial);
  const [mentions, setMentions] = useState<ReadonlyMap<string, string>>(new Map());
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const workspace = useOptionalWorkspace();

  async function send(): Promise<void> {
    const text = body.trim();
    if (text.length === 0) return;
    setBusy(true);
    // Only people still named in the text are notified.
    const ids = [...mentions].filter(([, name]) => text.includes(`@${name}`)).map(([id]) => id);
    const sent = await onSubmit(text, ids);
    setBusy(false);
    if (sent) {
      setBody('');
      setMentions(new Map());
    }
  }

  // The house convention (see the inline AI panel): Enter sends, Shift+Enter breaks the line,
  // Ctrl/Cmd+Enter always sends, and a touch keyboard keeps Enter for new lines.
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const touch = typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
    if (
      event.key === 'Enter' &&
      !event.nativeEvent.isComposing &&
      (event.ctrlKey || event.metaKey || (!touch && !event.shiftKey))
    ) {
      event.preventDefault();
      if (!busy) void send();
    }
  }

  const field = (
    <Textarea
      aria-label={label}
      placeholder={`${label}…`}
      value={body}
      maxLength={10000}
      rows={1}
      autoGrow
      resize="none"
      className={compact ? 'max-h-32 min-h-(--control-md) flex-1 py-1.5' : 'max-h-48'}
      onKeyDown={onKeyDown}
      onChange={(event) => {
        setBody(event.target.value);
      }}
    />
  );
  const picker =
    picking && workspace !== null ? (
      <MentionPicker
        onPick={(id, name) => {
          setMentions((current) => new Map(current).set(id, name));
          setBody(
            (current) => `${current}${current === '' || current.endsWith(' ') ? '' : ' '}@${name} `,
          );
          setPicking(false);
        }}
      />
    ) : null;

  if (compact) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-end gap-1">
          {field}
          {workspace === null ? null : (
            <CardIconButton
              label="Mention"
              icon={AtSign}
              onClick={() => {
                setPicking((current) => !current);
              }}
            />
          )}
          <Button
            variant="icon"
            aria-label={submitLabel}
            title={submitLabel}
            disabled={busy || body.trim() === ''}
            onClick={() => void send()}
          >
            <Icon icon={SendHorizontal} size="sm" />
          </Button>
        </div>
        {picker}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {quote === null ? null : (
        <Text
          variant="caption"
          tone="muted"
          className="line-clamp-2 border-l-2 border-divider pl-2"
        >
          {quote}
        </Text>
      )}
      {field}
      {picker}
      <div className="flex flex-wrap gap-1">
        <Button variant="primary" disabled={busy || body.trim() === ''} onClick={() => void send()}>
          {submitLabel}
        </Button>
        {onCancel === undefined ? null : (
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {workspace === null ? null : (
          <Button
            variant="ghost"
            aria-expanded={picking}
            onClick={() => {
              setPicking((current) => !current);
            }}
          >
            Mention
          </Button>
        )}
      </div>
    </div>
  );
}

function MentionPicker({
  onPick,
}: {
  readonly onPick: (principalId: string, name: string) => void;
}): ReactNode {
  const { principals, query, setQuery, status } = useWorkspaceAssignablePrincipals();
  return (
    <div className="flex flex-col gap-1">
      <Input
        aria-label="Find a person to mention"
        placeholder="Find a person…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <ul className="m-0 flex max-h-40 list-none flex-col overflow-y-auto p-0">
        {principals.slice(0, 20).map((person) => (
          <li key={person.principalId}>
            <button
              type="button"
              onClick={() => {
                onPick(person.principalId, person.displayName);
              }}
              className={`w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-foreground/7 ${focusRing}`}
            >
              {person.displayName}
            </button>
          </li>
        ))}
        {status === 'ready' && principals.length === 0 ? (
          <li>
            <Text variant="note" tone="muted">
              No one found.
            </Text>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
