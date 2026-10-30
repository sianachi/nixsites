import { Button, Text, blueprintFrame, chromeSurface, useAnchoredPanel } from '@nix/ui';
import { X } from 'lucide-react';
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
import { CardIconButton, Composer, ThreadCard, useCommentWrites } from './comment-thread-card';

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

/** The phone sheet sits above the writing dock and the keyboard the dock rides on. */
function clearOfWritingDock(): number {
  const dock = Number.parseFloat(
    document.documentElement.style.getPropertyValue('--mobile-note-toolbar-clearance'),
  );
  const viewport = window.visualViewport;
  const covered = viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
  return Number.isFinite(dock) ? Math.max(0, dock - Math.max(0, covered) + 8) : 0;
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

  // Beside the text, or centered when the text is gone (a detached thread).
  const anchor = (): CardAnchor | null =>
    editor.anchorOf(card) ?? {
      left: Math.max(8, (window.innerWidth - 320) / 2),
      top: window.innerHeight / 4,
      bottom: window.innerHeight / 4,
    };
  useAnchoredPanel(
    ref,
    anchor,
    `${card.kind}${'threadId' in card ? card.threadId : ''}`,
    clearOfWritingDock,
  );

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
    // Focus is usually back in the text after the click that opened the card, so Escape is heard here.
    function onEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') closeCard(itemId);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
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
      className={`${blueprintFrame} ${chromeSurface} fixed inset-auto z-50 m-0 flex w-[min(20rem,calc(100vw-16px))] max-h-[min(28rem,70dvh)] flex-col gap-3 overflow-y-auto bg-background p-3 text-foreground shadow-md max-sm:rounded-b-none max-sm:pb-[max(var(--spacing)*3,env(safe-area-inset-bottom))]`}
    >
      {card.kind === 'thread' ? (
        <ThreadBody itemId={itemId} threadId={card.threadId} onClose={close} />
      ) : card.kind === 'suggestions' ? (
        <SuggestionsBody itemId={itemId} ids={card.ids} editor={editor} onClose={close} />
      ) : (
        <ComposeBody itemId={itemId} onDone={close} />
      )}
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions */
}

function ThreadBody({
  itemId,
  threadId,
  onClose,
}: {
  readonly itemId: string;
  readonly threadId: string;
  readonly onClose: () => void;
}): ReactNode {
  const state = useItemComments(itemId);
  const { principal } = useCurrentPrincipal();
  const { problem, act } = useCommentWrites(itemId);
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  // Deleted elsewhere: once the feed has answered and the thread is absent, close the card.
  const gone = thread === undefined && state.status === 'ready';
  useEffect(() => {
    if (gone) closeCard(itemId);
  }, [gone, itemId]);
  return (
    <>
      {problem === null ? null : (
        <Text variant="note" role="alert">
          {problem}
        </Text>
      )}
      {thread === undefined ? (
        <Text variant="note" tone="muted" role="status">
          {state.status === 'error' ? 'This comment could not be loaded.' : 'Loading comment…'}
        </Text>
      ) : (
        <ThreadCard
          inline
          itemId={itemId}
          onClose={onClose}
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
  onClose,
}: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
  readonly onClose: () => void;
}): ReactNode {
  // Names come from the workspace's people; a note outside a workspace names nobody.
  return useOptionalWorkspace() === null ? (
    <SuggestionList itemId={itemId} ids={ids} editor={editor} names={new Map()} onClose={onClose} />
  ) : (
    <NamedSuggestions itemId={itemId} ids={ids} editor={editor} onClose={onClose} />
  );
}

function NamedSuggestions(props: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
  readonly onClose: () => void;
}): ReactNode {
  const { principals, hasMore, loadingMore, loadMore } = useWorkspaceAssignablePrincipals();
  const { threads } = useItemComments(props.itemId);
  // Comment authors are named by Core; the people list is paged, so it is read on until every
  // author here is found or it ends.
  const names = new Map<string, string>();
  for (const thread of threads)
    for (const comment of thread.comments) names.set(comment.authorId, comment.authorName);
  for (const person of principals) names.set(person.principalId, person.displayName);
  const { suggestions } = useItemComments(props.itemId);
  const missing = suggestions.some(
    (entry) => props.ids.includes(entry.id) && !names.has(entry.authorId),
  );
  useEffect(() => {
    if (missing && hasMore && !loadingMore) void loadMore();
  }, [missing, hasMore, loadingMore, loadMore]);
  return <SuggestionList {...props} names={names} />;
}

function SuggestionList({
  itemId,
  ids,
  editor,
  names,
  onClose,
}: {
  readonly itemId: string;
  readonly ids: readonly string[];
  readonly editor: CommentsEditorHandle;
  readonly onClose: () => void;
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
      : (names.get(entry.authorId) ?? 'A collaborator');

  return (
    <>
      {entries.map((entry, index) => (
        <section
          key={entry.id}
          aria-label={describeSuggestion(entry)}
          className="flex flex-col gap-2"
        >
          <div className="-my-1.5 flex items-center gap-2">
            <Text variant="bodySmall" className="min-w-0 flex-1">
              <span className="text-muted">Suggested by </span>
              <span className="font-medium">{author(entry)}</span>
              <span className="text-muted">
                {entry.createdAt === ''
                  ? ''
                  : ` · ${formatRelativeTime(new Date(entry.createdAt))}`}
              </span>
            </Text>
            {index === 0 ? <CardIconButton label="Close" icon={X} onClick={onClose} /> : null}
          </div>
          <Text variant="bodySmall">{describeSuggestion(entry)}</Text>
          {editor.editable ? (
            <div className="flex gap-1">
              <Button
                variant="primary"
                onClick={() => {
                  decide(entry, true);
                }}
              >
                Accept
              </Button>
              <Button
                variant="secondary"
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
