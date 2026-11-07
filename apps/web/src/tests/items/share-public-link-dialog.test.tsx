import { createNixClient } from '@nix/api-client';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { SharePublicLinkDialog } from '../../items/share-public-link-dialog';

const NOTE = 'a1111111-1111-4111-8111-a1111111a111';
const PRINCIPAL = 'f6666666-6666-4666-8666-666666666666';
const FILE = 'f1111111-1111-4111-8111-111111111111';

function linkBody(withheld = false): Record<string, unknown> {
  return {
    url: 'https://example.test/public/abc',
    itemId: NOTE,
    versionId: null,
    versionState: null,
    createdBy: PRINCIPAL,
    createdAt: '2026-11-01T00:00:00+00:00',
    withheldFiles: withheld ? [{ fileItemId: FILE, name: 'Contract.pdf' }] : [],
  };
}

function problem(status: number): Response {
  return Response.json(
    { type: 'about:blank', title: 'No', status, code: 'test.refused', detail: 'No.' },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** A fake fetch holding one note's link, recording each write's method and body. */
function setup(initial: 'none' | 'link' | 'withheld', createFails = false) {
  let exists = initial !== 'none';
  const writes: { method: string; body: unknown }[] = [];
  const client = createNixClient({
    baseUrl: 'http://nix.invalid',
    cache: { staleAfterMs: 0 },
    tokens: {
      getAccessToken: () => Promise.resolve(null),
      refreshAccessToken: () => Promise.resolve(null),
    },
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const text = typeof init?.body === 'string' ? init.body : await request?.clone().text();
        writes.push({ method, body: text ? (JSON.parse(text) as unknown) : null });
      }
      if (method === 'GET') {
        return exists ? Response.json(linkBody(initial === 'withheld')) : problem(404);
      }
      if (method === 'PUT') {
        if (createFails) return problem(403);
        exists = true;
        return Response.json(linkBody());
      }
      exists = false;
      return new Response(null, { status: 204 });
    },
  });
  const onClose = vi.fn();
  render(
    <ApiClientOverrideProvider client={client}>
      <SharePublicLinkDialog itemId={NOTE} title="Plan" onClose={onClose} />
    </ApiClientOverrideProvider>,
  );
  return { writes, onClose };
}

describe('the share public link dialog', () => {
  it('explains what sharing means, then creates the link with an empty body', async () => {
    const user = userEvent.setup();
    const { writes } = setup('none');

    const dialog = await screen.findByRole('dialog', { name: 'Share “Plan”' });
    expect(
      await within(dialog).findByText(/Anyone with the link can read this note/),
    ).toBeVisible();
    expect(
      within(dialog).getByText(/Comments, properties and child items stay private/),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create public link' }));

    expect(
      await within(dialog).findByDisplayValue('https://example.test/public/abc'),
    ).toBeVisible();
    expect(writes).toEqual([{ method: 'PUT', body: {} }]);
  });

  it('copies the address', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup('link');

    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://example.test/public/abc');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeVisible();
  });

  it('lists files the link withholds', async () => {
    setup('withheld');

    expect(await screen.findByText('Not shown, no approved version')).toBeVisible();
    expect(
      within(screen.getByRole('list', { name: 'Files not shown' })).getByText('Contract.pdf'),
    ).toBeVisible();
  });

  it('confirms in the same dialog before revoking', async () => {
    const user = userEvent.setup();
    const { writes } = setup('link');

    await user.click(await screen.findByRole('button', { name: 'Revoke public link' }));
    expect(writes).toEqual([]);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));

    await waitFor(() => {
      expect(writes).toEqual([{ method: 'DELETE', body: null }]);
    });
    expect(await screen.findByRole('button', { name: 'Create public link' })).toBeVisible();
  });

  it('says so when the link cannot be created', async () => {
    const user = userEvent.setup();
    setup('none', true);

    await user.click(await screen.findByRole('button', { name: 'Create public link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No.');
  });
});
