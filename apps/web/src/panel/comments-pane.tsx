import type { CommentThread } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { patchComments, useItemComments } from '@nix/web-editor/editor/comment-anchors';
import { useCommentFeed } from '@nix/web-editor/editor/use-comment-sync';
import { useCurrentPrincipal } from '@nix/web-platform/session/use-current-principal';
import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import type { CommentsEditorHandle } from '@nix/web-editor/editor/comment-anchors';
import type { SuggestionEntry } from '@nix/web-editor/editor/suggesting';
import { ERRORS, Composer, ThreadCard, useCommentWrites } from './comment-thread-card';

/**
 * An overview of the comments on the open note: its threads, a box for page-level comments, and the
 * suggestions made in suggestion mode. Comments and suggestions are read and decided at the text
 * (see `inline-comment-card.tsx`); choosing one here scrolls to its text and opens its card there.
 *
 * **The comments store holds the live state.** The pane joins the note's list/watch loop itself
 * (`useCommentFeed`, shared with the editor), so threads load even when no editor is mounted - a
 * note showing a view, or a locked one; anchored threads then appear by their quote. Suggestions
 * and the editor handle arrive only from a mounted editor. A viewer without permission sees Core's
 * refusal in words rather than a control that quietly does nothing.
 */

const KIND_LABELS: Readonly<Record<SuggestionEntry['kind'], string>> = {
  insert: 'Insertion',
  delete: 'Deletion',
  format: 'Formatting',
  block: 'Block change',
};

export function CommentsPane({ itemId }: { readonly itemId: string }): ReactNode {
  useCommentFeed(itemId);
  const state = useItemComments(itemId);
  const { principal } = useCurrentPrincipal();
  const [showResolved, setShowResolved] = useState(false);
  const { problem, act, addThread } = useCommentWrites(itemId);

  const open = state.threads.filter((thread) => thread.resolvedAt === null);
  const resolved = state.threads.filter((thread) => thread.resolvedAt !== null);
  const me = principal?.id ?? null;

  // Resolved threads are never in `detached`, so one renderer serves both lists.
  const card = (thread: CommentThread): ReactNode => (
    <ThreadCard
      key={thread.id}
      itemId={itemId}
      thread={thread}
      me={me}
      active={state.activeThreadId === thread.id}
      detached={state.detached.includes(thread.id)}
      canComment={state.canComment === true}
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

        {state.canComment !== true ? null : (
          <Composer
            label="New comment"
            submitLabel="Comment"
            onSubmit={(body, mentionIds) => addThread(body, mentionIds, null)}
          />
        )}

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
            No suggestions.
            {state.editor?.editable === true
              ? ' Turn on suggestion mode in the toolbar to propose edits.'
              : ''}
          </Text>
        ) : (
          state.suggestions.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              itemId={itemId}
              suggestion={suggestion}
              editor={state.editor}
            />
          ))
        )}
      </section>
    </div>
  );
}

function SuggestionRow({
  itemId,
  suggestion,
  editor,
}: {
  readonly itemId: string;
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
              patchComments(itemId, { card: { kind: 'suggestions', ids: [suggestion.id] } });
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
