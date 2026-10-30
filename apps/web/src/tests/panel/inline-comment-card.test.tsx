import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommentThread } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeCard,
  patchComments,
  readComments,
  requestComment,
  type CommentsEditorHandle,
} from '@nix/web-editor/editor/comment-anchors';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { InlineCommentCard, describeSuggestion } from '../../panel/inline-comment-card';

/** The card that opens at the text, over a seeded comments store and a stubbed editor handle. */

const ITEM = '5a5a5a5a-5555-4555-8555-5a5a5a5a5a5a';
const OTHER = '9c9c9c9c-9999-4999-8999-9c9c9c9c9c9c';

const THREAD: CommentThread = {
  id: 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0',
  anchorStart: null,
  anchorEnd: null,
  quote: 'quarterly review',
  resolvedAt: null,
  resolvedBy: null,
  resolvedByName: null,
  comments: [
    {
      id: 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0',
      authorId: OTHER,
      authorName: 'Ada',
      importedAuthor: null,
      body: 'Is this the right date?',
      mentionIds: [],
      createdAt: '2026-10-29T09:00:00.000Z',
      editedAt: null,
      deleted: false,
    },
  ],
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

const accept = vi.fn();
const reject = vi.fn();
const focus = vi.fn();
function handle(editable: boolean): CommentsEditorHandle {
  return {
    editable,
    accept,
    reject,
    focus,
    jumpTo: vi.fn(),
    anchorOf: () => ({ left: 100, top: 100, bottom: 120 }),
  };
}

let sent: { method: string; path: string; body: unknown }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  signedIn();
  stubCoreApi();
  sent = [];
  accept.mockClear();
  reject.mockClear();
  focus.mockClear();
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method !== 'GET' && url.pathname.includes('/comments')) {
      sent.push({
        method,
        path: url.pathname,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return Promise.resolve(Response.json(THREAD));
    }
    return base(input, init);
  });
  patchComments(ITEM, {
    threads: [THREAD],
    status: 'ready',
    ready: true,
    canComment: true,
    detached: [],
    draft: null,
    card: null,
    activeThreadId: null,
    suggestions: [
      {
        id: 's1',
        authorId: OTHER,
        createdAt: '2026-10-29T09:30:00.000Z',
        kind: 'insert',
        excerpt: 'new words',
        from: 5,
        to: 14,
      },
      {
        id: 's2',
        authorId: OTHER,
        createdAt: '2026-10-29T09:31:00.000Z',
        kind: 'delete',
        excerpt: 'old words',
        from: 5,
        to: 14,
      },
    ],
    editor: handle(true),
    refresh: vi.fn(),
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  closeCard(ITEM);
});

function renderCard(): void {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <InlineCommentCard itemId={ITEM} />
      </ApiClientProvider>
    </AuthProvider>,
  );
}

describe('the suggestion card', () => {
  it('says what changed and applies Accept, then closes', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1'] } });
    renderCard();

    expect(await screen.findByRole('dialog', { name: 'Suggested change' })).toBeVisible();
    expect(screen.getByText('Added “new words”')).toBeVisible();
    expect(screen.getByText(/A collaborator/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    expect(accept).toHaveBeenCalledWith('s1');
    expect(readComments(ITEM).card).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(focus).toHaveBeenCalled();
  });

  it('applies Reject', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1'] } });
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    expect(reject).toHaveBeenCalledWith('s1');
  });

  it('lists overlapping suggestions, each with its own buttons', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1', 's2'] } });
    renderCard();

    expect(await screen.findByText('Deleted “old words”')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Accept' })).toHaveLength(2);
    await user.click(must(screen.getAllByRole('button', { name: 'Reject' })[1]));
    expect(reject).toHaveBeenCalledWith('s2');
    expect(readComments(ITEM).card).toEqual({ kind: 'suggestions', ids: ['s1'] });
  });

  it('shows no Accept or Reject to someone who cannot edit', async () => {
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1'] }, editor: handle(false) });
    renderCard();

    expect(await screen.findByText('Added “new words”')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1'] } });
    renderCard();

    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(readComments(ITEM).card).toBeNull();
  });

  it('describes block changes in plain words', () => {
    const base = {
      id: 'b',
      authorId: '',
      createdAt: '',
      kind: 'block',
      excerpt: '',
      from: 0,
      to: 1,
    } as const;
    expect(describeSuggestion({ ...base, block: { op: 'insert', node: 'paragraph' } })).toBe(
      'New paragraph',
    );
    expect(describeSuggestion({ ...base, block: { op: 'delete', node: 'heading' } })).toBe(
      'Removed heading',
    );
    expect(describeSuggestion({ ...base, block: { op: 'restructure', node: 'bulletList' } })).toBe(
      'Restructured list',
    );
    expect(describeSuggestion({ ...base, kind: 'format' })).toBe('Formatting change');
  });
});

describe('the thread card', () => {
  it('shows the thread and posts a reply', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, {
      card: { kind: 'thread', threadId: THREAD.id },
      activeThreadId: THREAD.id,
    });
    renderCard();

    expect(await screen.findByText('Is this the right date?')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Fixed it');
    await user.click(screen.getByRole('button', { name: 'Reply' }));

    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'POST',
          path: `/api/v1/items/${ITEM}/comments/${THREAD.id}/replies`,
          body: { body: 'Fixed it', mentionIds: [] },
        },
      ]);
    });
  });
});

describe('the thread card controls', () => {
  it('sends a reply with Enter, and keeps Shift+Enter for a new line', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'thread', threadId: THREAD.id } });
    renderCard();

    await user.type(
      await screen.findByRole('textbox', { name: 'Reply' }),
      'a{Shift>}{Enter}{/Shift}b',
    );
    expect(sent).toEqual([]);
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(sent[0]?.body).toEqual({ body: 'a\nb', mentionIds: [] });
    });
  });

  it('resolves from the header and closes with the x', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'thread', threadId: THREAD.id } });
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(sent[0]).toMatchObject({ method: 'PUT' });
    });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(readComments(ITEM).card).toBeNull();
  });

  it('closes a suggestion card with the x', async () => {
    const user = userEvent.setup();
    patchComments(ITEM, { card: { kind: 'suggestions', ids: ['s1'] } });
    renderCard();

    await user.click(await screen.findByRole('button', { name: 'Close' }));
    expect(readComments(ITEM).card).toBeNull();
  });

  it('hides the reply field and Resolve from someone who cannot comment', async () => {
    patchComments(ITEM, { card: { kind: 'thread', threadId: THREAD.id }, canComment: false });
    renderCard();

    expect(await screen.findByText('Is this the right date?')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Reply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument();
  });
});

describe('a thread that is not there', () => {
  it('waits while loading, then closes once the feed is ready without it', async () => {
    patchComments(ITEM, {
      threads: [],
      status: 'loading',
      card: { kind: 'thread', threadId: THREAD.id },
    });
    renderCard();
    expect(await screen.findByText('Loading comment…')).toBeVisible();
    patchComments(ITEM, { status: 'ready' });
    await waitFor(() => {
      expect(readComments(ITEM).card).toBeNull();
    });
  });
});

describe('the new comment card', () => {
  it('opens a composer with the quote and posting creates a thread, shown in its own card', async () => {
    const user = userEvent.setup();
    requestComment(ITEM, { start: 'a', end: 'b', quote: 'quarterly review' });
    renderCard();

    expect(await screen.findByRole('dialog', { name: 'New comment' })).toBeVisible();
    expect(screen.getByText('quarterly review')).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: 'Comment on the selection' }), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      expect(sent[0]).toMatchObject({
        method: 'POST',
        path: `/api/v1/items/${ITEM}/comments`,
        body: { body: 'Hello', anchor: { start: 'a', end: 'b', quote: 'quarterly review' } },
      });
    });
    await waitFor(() => {
      expect(readComments(ITEM).card).toEqual({ kind: 'thread', threadId: THREAD.id });
    });
    expect(await screen.findByRole('dialog', { name: 'Comment thread' })).toBeVisible();
  });
});
