import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';

beforeEach(() => {
  signedIn();
});

const NOTE = '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a';
const FILE = '3b3b3b3b-3333-4333-8333-3b3b3b3b3b3b';
const OFF = { comments: false, suggesting: false, reviewStates: false, fullWidth: false };

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** The stub, plus an item whose settings the page can change and read back, and an optional public link. */
function stubSettings(options: { readonly link?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  const settings = new Map<string, Record<string, boolean>>([
    [NOTE, { ...OFF }],
    [FILE, { ...OFF, reviewStates: true }],
  ]);
  const inner = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input), globalThis.location.origin);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      ).toUpperCase();
      const id = /\/api\/v1\/items\/([0-9a-f-]{36})(\/settings|\/public-link)?$/.exec(url.pathname);
      if (id === null || (id[2] === undefined && method !== 'GET')) return inner(input, init);
      const [, itemId = '', tail] = id;
      const stored = settings.get(itemId);
      if (stored === undefined) return inner(input, init);
      if (tail === '/public-link') {
        return options.link === true
          ? json({
              url: 'https://example.test/public/abc',
              itemId,
              versionId: null,
              versionState: null,
              createdBy: itemId,
              createdAt: '2026-11-01T00:00:00+00:00',
              withheldFiles: [],
            })
          : json(
              { type: 'about:blank', title: 'None', status: 404, code: 'public_links.not_found' },
              404,
            );
      }
      if (tail === '/settings') {
        const body: unknown =
          typeof init?.body === 'string'
            ? JSON.parse(init.body)
            : await (input as Request).clone().json();
        calls.push({ method, path: url.pathname, body });
        for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
          if (typeof value === 'boolean') stored[key] = value;
        }
      }
      // The stub has no settings route, so the item is read the plain way and given its settings.
      const base = await inner(`/api/v1/items/${itemId}`, { method: 'GET' });
      const original = (await base.json()) as Record<string, unknown>;
      return json({ ...original, settings: stored });
    }),
  );
  return calls;
}

async function openSettings(itemId: string) {
  renderAt(<App />, `/?item=${itemId}`);
  await userEvent.click(await screen.findByRole('button', { name: 'Item settings' }));
  const panel = within(await screen.findByRole('complementary', { name: 'Item settings' }));
  await userEvent.click(panel.getByRole('button', { name: 'Settings' }));
  return panel;
}

describe('the item settings pane', () => {
  it('lists the note switches off, with no Comments pane until comments are on', async () => {
    stubCoreApi({ items: [item({ id: NOTE, title: 'Plan' })] });
    const calls = stubSettings();
    const panel = await openSettings(NOTE);

    expect(await panel.findByRole('checkbox', { name: 'Comments' })).not.toBeChecked();
    expect(panel.getByRole('checkbox', { name: 'Suggesting' })).not.toBeChecked();
    expect(panel.getByRole('checkbox', { name: 'Full width' })).not.toBeChecked();
    expect(panel.queryByRole('checkbox', { name: 'Review states' })).toBeNull();
    expect(panel.getByRole('combobox', { name: 'Default view' })).toBeVisible();
    expect(panel.queryByRole('button', { name: 'Comments' })).toBeNull();

    await userEvent.click(panel.getByRole('checkbox', { name: 'Comments' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toMatchObject({ comments: true, suggesting: null });
    expect(await panel.findByRole('button', { name: 'Comments' })).toBeVisible();
  });

  it('asks before turning review states off for a file that has a public link', async () => {
    stubCoreApi({ items: [item({ id: FILE, title: 'Contract', type: 'file' })] });
    const calls = stubSettings({ link: true });
    const panel = await openSettings(FILE);

    const toggle = await panel.findByRole('checkbox', { name: 'Review states' });
    expect(toggle).toBeChecked();
    expect(panel.queryByRole('checkbox', { name: 'Comments' })).toBeNull();

    await userEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Turn off review states?' });
    expect(calls).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toMatchObject({ reviewStates: false });
  });

  it('turns review states off at once for a file with no public link', async () => {
    stubCoreApi({ items: [item({ id: FILE, title: 'Contract', type: 'file' })] });
    const calls = stubSettings();
    const panel = await openSettings(FILE);

    await userEvent.click(await panel.findByRole('checkbox', { name: 'Review states' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(screen.queryByRole('dialog', { name: 'Turn off review states?' })).toBeNull();
  });
});
