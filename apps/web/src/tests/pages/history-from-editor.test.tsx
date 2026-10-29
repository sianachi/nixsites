import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

/**
 * Version history, from the application rather than from a module nobody reaches.
 *
 * The sidebar, the hook and the routes were built as separate packages; this is the test that
 * fails if the button that joins them to the page is ever removed.
 */

vi.mock('../../history/use-document-history', () => ({
  useDocumentHistory: () => ({
    revisions: [],
    hasMore: false,
    loadMore: () => Promise.resolve(),
    namedVersions: [],
    headSeq: null,
    loading: false,
    refusal: null,
    stateAt: () => Promise.resolve({ ok: true, value: null }),
    restore: () => Promise.resolve({ ok: true, value: { headSeq: 1 } }),
    nameVersion: () => Promise.resolve({ ok: false, refusal: { code: 'x', detail: 'x' } }),
    removeName: () => Promise.resolve({ ok: true, value: true }),
    refresh: () => Promise.resolve(),
  }),
}));

beforeEach(() => {
  signedIn();
});

const NOTE = item({
  id: '4d4d4d4d-4444-4444-8444-4d4d4d4d4d4d',
  title: 'Design notes',
});

describe('the document’s history, from the page', () => {
  it('opens beside the document from the item actions menu, and closes again', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(screen.queryByRole('complementary', { name: 'History' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'History' }));
    expect(await screen.findByRole('complementary', { name: 'History' })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Close history' }));
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: 'History' })).not.toBeInTheDocument();
    });
  });
});
