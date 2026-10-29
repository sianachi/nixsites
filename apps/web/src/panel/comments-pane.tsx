import { comments, isNixApiError, type Comment, type CommentThread } from '@nix/api-client';
import { Button, Input, Text, Textarea, focusRing } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import {
  patchComments,
  useItemComments,
  type CapturedAnchor,
} from '@nix/web-editor/editor/comment-anchors';
import { useCommentFeed } from '@nix/web-editor/editor/use-comment-sync';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useCurrentPrincipal } from '@nix/web-platform/session/use-current-principal';
import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';
import type { CommentsEditorHandle } from '@nix/web-editor/editor/comment-anchors';
import type { SuggestionEntry } from '@nix/web-editor/editor/suggesting';

/**
 * The comments on the open note: threads anchored to its text, a box for page-level comments, and
 * the suggestions made in suggestion mode.
 *
 * **The comments store holds the live state.** The pane joins the note's list/watch loop itself
 * (`useCommentFeed`, shared with the editor), so threads load even when no editor is mounted - a
 * note showing a view, or a locked one; anchored threads then appear by their quote. Suggestions
 * and the editor handle arrive only from a mounted editor. A viewer without permission sees Core's
 * refusal in words rather than a control that quietly does nothing.
 */

const ERRORS: Readonly<Record<string, string>> = {
  'comments.forbidden': 'You do not have permission to comment on this note.',
  'comments.not_author': 'Only the author can change this comment.',
  'items.locked': 'This note is locked.',
};

function refusalText(reason: unknown): string {
  if (isNixApiError(reason)) {
    if (reason.status === 409) return 'This note is in the trash.';
    return ERRORS[reason.code] ?? reason.detail ?? 'That did not work. Try again.';
  }
  return 'Core could not be reached.';
}

const KIND_LABELS: Readonly<Record<SuggestionEntry['kind'], string>> = {
  insert: 'Insertion',
  delete: 'Deletion',
  format: 'Formatting',
  block: 'Block change',
};

function authorLabel(comment: Comment): string {
  return comment.importedAuthor === null
    ? comment.authorName
    : `by ${comment.importedAuthor} (imported)`;
}

export function CommentsPane({ itemId }: { readonly itemId: string }): ReactNode {
  const client = useApiClient();
  useCommentFeed(itemId);
  const state = useItemComments(itemId);
  const { principal } = useCurrentPrincipal();
  const [showResolved, setShowResolved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Runs one write, then re-reads; a refusal is shown in the pane. */
  async function act(write: () => Promise<unknown>): Promise<boolean> {
    setProblem(null);
    try {
      await write();
      state.refresh();
      return true;
    } catch (reason) {
      setProblem(refusalText(reason));
      return false;
    }
  }

  const open = state.threads.filter((thread) => thread.resolvedAt === null);
  const resolved = state.threads.filter((thread) => thread.resolvedAt !== null);
  const me = principal?.id ?? null;

  const addThread = (
    body: string,
    mentionIds: readonly string[],
    anchor: CapturedAnchor | null,
  ): Promise<boolean> =>
    act(async () => {
      const created = await client.execute(
        comments.add(itemId, { body, mentionIds, ...(anchor === null ? {} : { anchor }) }),
      );
      patchComments(itemId, { draft: null, activeThreadId: created.id });
    });

  // Resolved threads are never in `detached`, so one renderer serves both lists.
  const card = (thread: CommentThread): ReactNode => (
    <ThreadCard
      key={thread.id}
      itemId={itemId}
      thread={thread}
      me={me}
      active={state.activeThreadId === thread.id}
      detached={state.detached.includes(thread.id)}
      act={act}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}

      <section aria-label="Comment threads" className="flex flex-col gap-3">
        <Text variant="kicker" tone="muted">
          Threads
        </Text>

        {state.status === 'error' ? (
          <Text variant="note" tone="muted" role="status">
            {(state.errorCode === null ? null : ERRORS[state.errorCode]) ??
              state.errorDetail ??
              'Comments could not be loaded.'}
          </Text>
        ) : state.status === 'loading' ? (
          <Text variant="note" tone="muted" role="status">
            Loading comments…
          </Text>
        ) : null}

        <Composer
          key={state.draft?.start ?? 'page'}
          label={state.draft === null ? 'New comment' : 'Comment on the selection'}
          quote={state.draft?.quote ?? null}
          submitLabel="Comment"
          onSubmit={(body, mentionIds) => addThread(body, mentionIds, state.draft)}
          onCancel={
            state.draft === null
              ? undefined
              : () => {
                  patchComments(itemId, { draft: null });
                }
          }
        />

        {open.length === 0 && state.status === 'ready' ? (
          <Text variant="note" tone="muted">
            No open comments.
          </Text>
        ) : null}
        {open.map(card)}

        {resolved.length === 0 ? null : (
          <>
            <Button
              variant="ghost"
              aria-expanded={showResolved}
              onClick={() => {
                setShowResolved((current) => !current);
              }}
            >
              {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
            </Button>
            {showResolved ? resolved.map(card) : null}
          </>
        )}
      </section>

      <section aria-label="Suggestions" className="flex flex-col gap-2">
        <Text variant="kicker" tone="muted">
          Suggestions
        </Text>
        {state.suggestions.length === 0 ? (
          <Text variant="note" tone="muted">
            No suggestions. Turn on suggestion mode in the toolbar to propose edits.
          </Text>
        ) : (
          state.suggestions.map((suggestion) => (
            <SuggestionRow key={suggestion.id} suggestion={suggestion} editor={state.editor} />
          ))
        )}
      </section>
    </div>
  );
}

function SuggestionRow({
  suggestion,
  editor,
}: {
  readonly suggestion: SuggestionEntry;
  readonly editor: CommentsEditorHandle | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-sm border border-divider p-2">
      <Text variant="caption" tone="muted">
        {KIND_LABELS[suggestion.kind]}
        {suggestion.createdAt === ''
          ? ''
          : `, ${formatRelativeTime(new Date(suggestion.createdAt))}`}
      </Text>
      <Text variant="bodySmall">{suggestion.excerpt || 'No text'}</Text>
      {editor === null ? null : (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="ghost"
            onClick={() => {
              editor.jumpTo(suggestion.from);
            }}
          >
            Jump
          </Button>
          {editor.editable ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  editor.accept(suggestion.id);
                }}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  editor.reject(suggestion.id);
                }}
              >
                Reject
              </Button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ThreadCard({
  itemId,
  thread,
  me,
  active,
  detached,
  act,
}: {
  readonly itemId: string;
  readonly thread: CommentThread;
  readonly me: string | null;
  readonly active: boolean;
  readonly detached: boolean;
  readonly act: (write: () => Promise<unknown>) => Promise<boolean>;
}): ReactNode {
  const client = useApiClient();
  const [replying, setReplying] = useState(false);
  const isResolved = thread.resolvedAt !== null;

  return (
    <article
      aria-label={`Comment thread${thread.quote === null ? '' : ` on ${thread.quote}`}`}
      className={`flex flex-col gap-2 rounded-sm border p-2 ${
        active ? 'border-accent' : 'border-divider'
      }`}
    >
      {thread.quote === null ? null : (
        <button
          type="button"
          onClick={() => {
            patchComments(itemId, { activeThreadId: thread.id });
          }}
          className={`rounded-sm border-l-2 border-divider pl-2 text-left text-sm text-muted ${focusRing}`}
        >
          {thread.quote}
        </button>
      )}
      {detached ? (
        <Text variant="caption" tone="muted">
          The text this comment was on has changed or been removed.
        </Text>
      ) : null}

      {thread.comments.map((comment) => (
        <CommentRow key={comment.id} itemId={itemId} comment={comment} me={me} act={act} />
      ))}

      {isResolved ? (
        <Text variant="caption" tone="muted">
          Resolved{thread.resolvedByName === null ? '' : ` by ${thread.resolvedByName}`}
        </Text>
      ) : null}

      <div className="flex flex-wrap gap-1">
        <Button
          variant="ghost"
          aria-expanded={replying}
          onClick={() => {
            setReplying((current) => !current);
          }}
        >
          Reply
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            void act(() => client.execute(comments.setResolved(itemId, thread.id, !isResolved)));
          }}
        >
          {isResolved ? 'Reopen' : 'Resolve'}
        </Button>
      </div>

      {replying ? (
        <Composer
          label="Reply"
          submitLabel="Reply"
          onSubmit={async (body, mentionIds) => {
            const sent = await act(() =>
              client.execute(comments.reply(itemId, thread.id, { body, mentionIds })),
            );
            if (sent) setReplying(false);
            return sent;
          }}
          onCancel={() => {
            setReplying(false);
          }}
        />
      ) : null}
    </article>
  );
}

function CommentRow({
  itemId,
  comment,
  me,
  act,
}: {
  readonly itemId: string;
  readonly comment: Comment;
  readonly me: string | null;
  readonly act: (write: () => Promise<unknown>) => Promise<boolean>;
}): ReactNode {
  const client = useApiClient();
  const [editing, setEditing] = useState(false);
  const mine = me !== null && comment.authorId === me;

  return (
    <div className="flex flex-col gap-1">
      <Text variant="caption" tone="muted">
        {authorLabel(comment)}, {formatRelativeTime(new Date(comment.createdAt))}
        {comment.editedAt === null ? '' : ' (edited)'}
      </Text>
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
      {mine && !editing ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              void act(() => client.execute(comments.remove(itemId, comment.id)));
            }}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A text box with an optional mention picker; `onSubmit` answers whether it was sent. */
function Composer({
  label,
  submitLabel,
  quote = null,
  initial = '',
  onSubmit,
  onCancel,
}: {
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

  return (
    <div className="flex flex-col gap-2">
      {quote === null ? null : (
        <Text variant="caption" tone="muted" className="border-l-2 border-divider pl-2">
          {quote}
        </Text>
      )}
      <Textarea
        aria-label={label}
        placeholder={`${label}…`}
        value={body}
        maxLength={10000}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      {picking && workspace !== null ? (
        <MentionPicker
          onPick={(id, name) => {
            setMentions((current) => new Map(current).set(id, name));
            setBody(
              (current) =>
                `${current}${current === '' || current.endsWith(' ') ? '' : ' '}@${name} `,
            );
            setPicking(false);
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-1">
        <Button
          variant="secondary"
          disabled={busy || body.trim() === ''}
          onClick={() => void send()}
        >
          {submitLabel}
        </Button>
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
        {onCancel === undefined ? null : (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
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
