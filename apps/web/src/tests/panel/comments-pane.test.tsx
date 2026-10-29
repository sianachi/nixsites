import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CommentThread } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { patchComments, readComments } from '@nix/web-editor/editor/comment-anchors';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { CommentsPane } from '../../panel/comments-pane';

/**
 * The comments pane over a seeded store: it renders what the editor publishes, sends the viewer's
 * own actions to Core, and offers edit and delete only on the viewer's own comments.
 */

const ITEM = '5a5a5a5a-5555-4555-8555-5a5a5a5a5a5a';
// The id the api stub gives the signed-in caller.
const ME = '1b1b1b1b-1111-4111-8111-1b1b1b1b1b1b';
const OTHER = '9c9c9c9c-9999-4999-8999-9c9c9c9c9c9c';

function comment(id: string, authorId: string, body: string, authorName: string) {
  return {
    id,
    authorId,
    authorName,
    importedAuthor: null,
    body,
    mentionIds: [],
    createdAt: '2026-10-29T09:00:00.000Z',
    editedAt: null,
    deleted: false,
  };
}

const OPEN: CommentThread = {
  id: 'a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0',
  anchorStart: null,
  anchorEnd: null,
  quote: 'quarterly review',
  resolvedAt: null,
  resolvedBy: null,
  resolvedByName: null,
  comments: [
    comment('a0a0a0a0-0000-4000-8000-a0a0a0a0a0a0', OTHER, 'Is this the right date?', 'Ada'),
    comment('b0b0b0b0-0000-4000-8000-b0b0b0b0b0b0', ME, 'Checking now.', 'Test Person'),
  ],
};

const RESOLVED: CommentThread = {
  id: 'c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0',
  anchorStart: null,
  anchorEnd: null,
  quote: null,
  resolvedAt: '2026-10-29T10:00:00.000Z',
  resolvedBy: OTHER,
  resolvedByName: 'Ada',
  comments: [comment('c0c0c0c0-0000-4000-8000-c0c0c0c0c0c0', OTHER, 'Old question.', 'Ada')],
};

const accept = vi.fn();
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Expected a value.');
  return value;
}

let listed: CommentThread[];
let sent: { method: string; path: string; body: unknown }[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  signedIn();
  stubCoreApi();
  sent = [];
  listed = [OPEN, RESOLVED];
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
      return Promise.resolve(Response.json(OPEN));
    }
    if (method === 'GET' && url.pathname.endsWith(`/items/${ITEM}/comments`)) {
      return Promise.resolve(Response.json({ revision: 1, threads: listed, canComment: true }));
    }
    // The long-poll: nothing new, so it never answers.
    if (url.pathname.endsWith('/comments/watch')) return new Promise<Response>(() => undefined);
    return base(input, init);
  });
  patchComments(ITEM, {
    threads: [OPEN, RESOLVED],
    status: 'ready',
    ready: true,
    detached: [OPEN.id],
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
    ],
    draft: null,
    editor: { editable: true, jumpTo: vi.fn(), accept, reject: vi.fn() },
    refresh: vi.fn(),
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function renderPane(): void {
  renderAt(
    <AuthProvider>
      <ApiClientProvider>
        <CommentsPane itemId={ITEM} />
      </ApiClientProvider>
    </AuthProvider>,
  );
}

describe('the comments pane', () => {
  it('lists open threads, shows a detached one with its quote, and hides resolved ones', async () => {
    renderPane();

    expect(await screen.findByText('Is this the right date?')).toBeVisible();
    expect(screen.getByText('quarterly review')).toBeVisible();
    expect(screen.getByText(/text this comment was on has changed/i)).toBeVisible();
    expect(screen.queryByText('Old question.')).not.toBeInTheDocument();
  });

  it('shows resolved threads on request', async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(await screen.findByRole('button', { name: /show resolved \(1\)/i }));

    expect(screen.getByText('Old question.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  it("offers edit and delete only on the viewer's own comments", async () => {
    renderPane();
    const mine = must((await screen.findByText('Checking now.')).parentElement);
    const theirs = must(screen.getByText('Is this the right date?').parentElement);

    await waitFor(() => {
      expect(within(mine).getByRole('button', { name: 'Edit' })).toBeVisible();
    });
    expect(within(mine).getByRole('button', { name: 'Delete' })).toBeVisible();
    expect(within(theirs).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('shows a deleted root as muted text with no actions, and keeps its replies', async () => {
    const rootId = 'd0d0d0d0-0000-4000-8000-d0d0d0d0d0d0';
    const tombstone: CommentThread = {
      ...OPEN,
      id: rootId,
      quote: null,
      comments: [
        { ...comment(rootId, ME, '', 'Test Person'), deleted: true },
        comment('e0e0e0e0-0000-4000-8000-e0e0e0e0e0e0', OTHER, 'Still here.', 'Ada'),
      ],
    };
    listed = [tombstone];
    patchComments(ITEM, { threads: [tombstone], detached: [] });
    renderPane();

    expect(await screen.findByText('Comment deleted')).toBeVisible();
    expect(screen.getByText('Still here.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('posts a reply to the thread', async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(await screen.findByRole('button', { name: 'Reply' }));
    await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Fixed it');
    await user.click(must(screen.getAllByRole('button', { name: 'Reply' }).at(-1)));

    await waitFor(() => {
      expect(sent).toEqual([
        {
          method: 'POST',
          path: `/api/v1/items/${ITEM}/comments/${OPEN.id}/replies`,
          body: { body: 'Fixed it', mentionIds: [] },
        },
      ]);
    });
  });

  it('lists suggestions and drives the editor from them', async () => {
    const user = userEvent.setup();
    renderPane();

    expect(await screen.findByText('new words')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Accept' }));
    expect(accept).toHaveBeenCalledWith('s1');
  });

  it('hides accept and reject when the note cannot be edited', async () => {
    patchComments(ITEM, {
      editor: { editable: false, jumpTo: vi.fn(), accept: vi.fn(), reject: vi.fn() },
    });
    renderPane();

    expect(await screen.findByText('new words')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Jump' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
  });

  it('loads threads by quote with no editor mounted, and forgets them on unmount', async () => {
    patchComments(ITEM, { ready: false, editor: null, detached: [], suggestions: [] });
    const view = renderAt(
      <AuthProvider>
        <ApiClientProvider>
          <CommentsPane itemId={ITEM} />
        </ApiClientProvider>
      </AuthProvider>,
    );

    expect(await screen.findByText('quarterly review')).toBeVisible();
    view.unmount();
    expect(readComments(ITEM).threads).toEqual([]);
  });
});
