import { Button, Text, blueprintFrame, chromeSurface, useAnchoredPanel } from '@nix/ui';
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

import {
  closeCard,
  patchComments,
  useItemComments,
  type CardAnchor,
  type CommentCard,
  type CommentsEditorHandle,
} from '@nix/web-editor/editor/comment-anchors';
import type { SuggestionEntry } from '@nix/web-editor/editor/suggesting';
import { formatRelativeTime } from '@nix/web-foundation/lib/date-format';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { useCurrentPrincipal } from '@nix/web-platform/session/use-current-principal';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useWorkspaceAssignablePrincipals } from '@nix/web-workspaces/workspaces/use-workspace-assignable-principals';
import { Composer, ThreadCard, useCommentWrites } from './comment-thread-card';

/**
 * The card that opens at the text: a comment thread, the suggestions under a click, or the box for
 * a new comment. One at a time, driven by `card` in the comments store (set by clicks in the text,
 * the selection menu's Comment button, and the pane). Placed beside the text by `useAnchoredPanel`
 * (flips above, stays in the viewport, follows scroll and resize), which makes it a bottom sheet on
 * a phone. Focus moves into the card on open and back to the text on close.
 */

const BLOCK_NAMES: Readonly<Record<string, string>> = {
  paragraph: 'paragraph',
  heading: 'heading',
  blockquote: 'quote',
  codeBlock: 'code block',
  callout: 'callout',
  image: 'image',
  bulletList: 'list',
  orderedList: 'list',
  taskList: 'list',
  listItem: 'list item',
  taskItem: 'task',
  table: 'table',
};

/** What a suggestion changes, in plain words. */
export function describeSuggestion(entry: SuggestionEntry): string {
  const quoted = `“${entry.excerpt}”`;
  if (entry.kind === 'insert') return entry.excerpt === '' ? 'Added text' : `Added ${quoted}`;
  if (entry.kind === 'delete') return entry.excerpt === '' ? 'Deleted text' : `Deleted ${quoted}`;
  if (entry.kind === 'format') return 'Formatting change';
  const name = BLOCK_NAMES[entry.block?.node ?? ''] ?? 'block';
  if (entry.block?.op === 'insert') return `New ${name}`;
  if (entry.block?.op === 'delete') return `Removed ${name}`;
  return `Restructured ${name}`;
}

export function InlineCommentCard({ itemId }: { readonly itemId: string }): ReactNode {
  const { card, editor } = useItemComments(itemId);
  if (card === null || editor === null) return null;
  return <CardFrame itemId={itemId} card={card} editor={editor} />;
}

function CardFrame({
  itemId,
  card,
  editor,
}: {
  readonly itemId: string;
  readonly card: CommentCard;
  readonly editor: CommentsEditorHandle;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const label =
    card.kind === 'thread'
      ? 'Comment thread'
      : card.kind === 'suggestions'
        ? 'Suggested change'
        : 'New comment';
  const close = (): void => {
    closeCard(itemId);
  };

  // Beside the text, or at the top of the note when the text is gone (a detached thread).
  const anchor = (): CardAnchor | null =>
    editor.anchorOf(card) ?? { left: 16, top: 72, bottom: 72 };
  useAnchoredPanel(ref, anchor, `${card.kind}${'threadId' in card ? card.threadId : ''}`);

  // Focus in on open, back to the text on close.
  useEffect(() => {
    const panel = ref.current;
    const first = panel?.querySelector<HTMLElement>('textarea, button, [href]');
    (first ?? panel)?.focus();
    return () => {
      editor.focus();
    };
    // Only on open: a thread posting its reply must not steal focus again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A press outside closes it; one in the text is left to the editor, which opens the next card.
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target) === true) return;
      if (target.closest('.ProseMirror, [role="dialog"], [role="menu"]') !== null) return;
      closeCard(itemId);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [itemId]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions -- Escape closes a dialog. */
  return (
    <div
      ref={ref}
      popover="manual"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`${blueprintFrame} ${chromeSurface} fixed inset-auto z-50 m-0 flex w-[min(24rem,calc(100vw-16px))] flex-col gap-2 overflow-y-auto bg-background p-3 text-foreground shadow-md max-sm:rounded-b-none max-sm:pb-[max(var(--spacing)*3,env(safe-area-inset-bottom))]`}
    >
      {card.kind === 'thread' ? (
        <ThreadBody itemId={itemId} threadId={card.threadId} />
      ) : card.kind === 'suggestions' ? (
        <SuggestionsBody itemId={itemId} ids={card.ids} editor={editor} />
      ) : (
        <ComposeBody itemId={itemId} onDone={close} />
      )}
      <Button variant="ghost" onClick={close}>
        Close
      </Button>
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
}

function ThreadBody({
  itemId,
  threadId,
}: {
  readonly itemId: string;
  readonly threadId: string;
}): ReactNode {
  const state = useItemComments(itemId);
  const { principal } = useCurrentPrincipal();
  const { problem, act } = useCommentWrites(itemId);
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  return (
    <>
      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}
      {thread === undefined ? (
        <Text variant="note" tone="muted" role="status">
          Loading comment…
        </Text>
      ) : (
        <ThreadCard
          inline
          itemId={itemId}
          thread={thread}
          me={principal?.id ?? null}
          active={false}
          detached={state.detached.includes(thread.id)}
          canComment={state.canComment === true}
          act={act}
        />
      )}
    </>
  );
}

function ComposeBody({
  itemId,
  onDone,
}: {
  readonly itemId: string;
  readonly onDone: () => void;
}): ReactNode {
  const { draft } = useItemComments(itemId);
  const { problem, addThread } = useCommentWrites(itemId);
  return (
    <>
      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}
      <Composer
        label={draft === null ? 'New comment' : 'Comment on the selection'}
        quote={draft?.quote ?? null}
        submitLabel="Post"
        onSubmit={(body, mentionIds) => addThread(body, mentionIds, draft)}
        onCancel={onDone}
      />
    </>
  );
}

function SuggestionsBody({
  itemId,
  ids,
  editor,
}: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
}): ReactNode {
  // Names come from the workspace's people; a note outside a workspace names nobody.
  return useOptionalWorkspace() === null ? (
    <SuggestionList itemId={itemId} ids={ids} editor={editor} names={new Map()} />
  ) : (
    <NamedSuggestions itemId={itemId} ids={ids} editor={editor} />
  );
}

function NamedSuggestions(props: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
}): ReactNode {
  const { principals } = useWorkspaceAssignablePrincipals();
  const names = new Map(principals.map((person) => [person.principalId, person.displayName]));
  return <SuggestionList {...props} names={names} />;
}

function SuggestionList({
  itemId,
  ids,
  editor,
  names,
}: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
  readonly names: ReadonlyMap<string, string>;
}): ReactNode {
  const { suggestions } = useItemComments(itemId);
  const { principal } = useCurrentPrincipal();
  const subject = useSessionStore((state) => state.profile?.subject);
  const entries = suggestions.filter((entry) => ids.includes(entry.id));

  // Every suggestion decided (or gone): nothing left to show.
  const empty = entries.length === 0;
  useEffect(() => {
    if (empty) closeCard(itemId);
  }, [empty, itemId]);

  /** Applies one decision; the rest of an overlap stay open. */
  function decide(entry: SuggestionEntry, accept: boolean): void {
    if (accept) editor.accept(entry.id);
    else editor.reject(entry.id);
    const rest = ids.filter((id) => id !== entry.id);
    patchComments(itemId, {
      card: rest.length === 0 ? null : { kind: 'suggestions', ids: rest },
      suggestions: suggestions.filter((candidate) => candidate.id !== entry.id),
    });
  }

  const author = (entry: SuggestionEntry): string =>
    entry.authorId !== '' && (entry.authorId === subject || entry.authorId === principal?.id)
      ? 'You'
      : (names.get(entry.authorId) ?? 'Someone');

  return (
    <>
      {entries.map((entry) => (
        <section
          key={entry.id}
          aria-label={describeSuggestion(entry)}
          className="flex flex-col gap-1"
        >
          <Text variant="caption" tone="muted">
            {author(entry)}
            {entry.createdAt === '' ? '' : `, ${formatRelativeTime(new Date(entry.createdAt))}`}
          </Text>
          <Text variant="bodySmall">{describeSuggestion(entry)}</Text>
          {editor.editable ? (
            <div className="flex gap-1">
              <Button
                variant="secondary"
                onClick={() => {
                  decide(entry, true);
                }}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  decide(entry, false);
                }}
              >
                Reject
              </Button>
            </div>
          ) : null}
        </section>
      ))}
    </>
  );
}
