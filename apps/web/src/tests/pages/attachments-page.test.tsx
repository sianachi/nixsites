import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

const PAGE = `/w/${STUB_WORKSPACE_ID}/attachments`;
const FILE = 'f1111111-1111-4111-8111-111111111111';
const VERSION = 'f2222222-2222-4222-8222-222222222222';
const SOURCE = 'f3333333-3333-4333-8333-333333333333';
const HOLDER = 'f4444444-4444-4444-8444-444444444444';
const REFERENCE = 'f5555555-5555-4555-8555-555555555555';
const SECOND = 'f7777777-7777-4777-8777-777777777777';
const SECOND_VERSION = 'f8888888-8888-4888-8888-888888888888';
const THIRD = 'f9999999-9999-4999-8999-999999999999';
const THIRD_VERSION = 'fa000000-0000-4000-8000-000000000000';
const PRINCIPAL = 'f6666666-6666-4666-8666-666666666666';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: FILE,
    title: 'Contract.pdf',
    mediaType: 'application/pdf',
    shownVersionId: VERSION,
    shownVersionState: 'draft',
    expiresAt: null,
    sourceItemId: SOURCE,
    pinCount: 2,
    hasPublicLink: false,
    // The approval flow these tests cover needs review states on; the off case has its own test.
    reviewStates: true,
    ...overrides,
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly body: unknown;
}

interface Options {
  readonly rows?: readonly Record<string, unknown>[];
  readonly listStatus?: number;
  readonly linkStatus?: number;
}

function stubAttachments(options: Options = {}): Call[] {
  const inner = globalThis.fetch;
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(requestUrl(input), globalThis.location.origin);
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const text =
        typeof init?.body === 'string'
          ? init.body
          : request !== null && method !== 'GET'
            ? await request.clone().text()
            : '';
      const path = url.pathname;
      const ours =
        path.endsWith('/attachments') ||
        path.endsWith('/referenced-by') ||
        path.endsWith('/public-link') ||
        path.includes('/references/') ||
        path.endsWith('/state') ||
        path.endsWith('/properties') ||
        path.endsWith('/file/download');
      if (!ours) return inner(input, init);
      calls.push({
        method,
        path,
        search: url.search,
        body: text === '' ? undefined : JSON.parse(text),
      });

      if (path.endsWith('/attachments')) {
        return options.listStatus === undefined
          ? json({ items: options.rows ?? [row()], nextCursor: null })
          : json(
              {
                type: 'about:blank',
                title: 'Nope',
                status: options.listStatus,
                code: 'attachments.not_implemented',
                detail: 'This route is not implemented yet.',
              },
              options.listStatus,
            );
      }
      if (path.endsWith('/referenced-by')) {
        return json({
          items: [
            {
              id: REFERENCE,
              holderItemId: HOLDER,
              holderTitle: 'Offer record',
              holderAvailable: true,
              targetItemId: FILE,
              targetFileVersionId: VERSION,
              role: 'pin',
              createdBy: PRINCIPAL,
              createdAt: '2026-11-01T00:00:00+00:00',
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith('/public-link')) {
        if (options.linkStatus !== undefined && method !== 'DELETE') {
          return json(
            {
              type: 'about:blank',
              title: 'Off',
              status: options.linkStatus,
              code: 'public_links.disabled',
              detail: 'Off.',
            },
            options.linkStatus,
          );
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        return json({
          url: 'https://example.test/public/abc',
          itemId: FILE,
          versionId: VERSION,
          versionState: 'approved',
          createdBy: PRINCIPAL,
          createdAt: '2026-11-01T00:00:00+00:00',
          withheldFiles: [],
        });
      }
      if (path.includes('/references/')) return new Response(null, { status: 204 });
      if (path.endsWith('/properties')) {
        // The client parses the answer as an item; a bare {} would fail it and block the undo entry.
        return json({
          id: FILE,
          workspaceId: STUB_WORKSPACE_ID,
          title: 'Contract.pdf',
          type: 'file',
          parentId: null,
          hasChildren: false,
          seq: 1,
          lifecycleState: 'active',
          properties: {},
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        });
      }
      if (path.endsWith('/file/download')) {
        return json({
          url: 'https://files.example.test/x',
          expiresAt: '2026-11-06T00:00:00+00:00',
          fileName: 'Contract.pdf',
          mediaType: 'application/pdf',
          byteLength: 4,
          sha256: 'a'.repeat(64),
          inline: false,
          unscanned: false,
          noSniff: true,
        });
      }
      return json({});
    }),
  );
  return calls;
}

async function manage(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Manage Contract.pdf' }));
}

beforeEach(() => {
  signedIn();
  stubViewport(false);
  stubCoreApi();
});

describe('the attachments page', () => {
  it('shows each file with its state, source, pins and link flag', async () => {
    stubAttachments({
      rows: [
        row({
          shownVersionState: 'approved',
          expiresAt: '2027-03-01T00:00:00+00:00',
          hasPublicLink: true,
        }),
      ],
    });
    renderAt(<App />, PAGE);

    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(list).getByText('Contract.pdf')).toBeVisible();
    expect(within(list).getByText('Approved')).toBeVisible();
    expect(within(list).getByText('Public link')).toBeVisible();
    // The rest is one tap away, not on every row.
    expect(within(list).queryByText('2 pins')).toBeNull();
    await manage(userEvent.setup());
    expect(within(list).getByText('Expires 2027-03-01')).toBeVisible();
    expect(within(list).getByText('2 pins')).toBeVisible();
    expect(within(list).getByRole('link', { name: 'Source note' })).toHaveAttribute(
      'href',
      expect.stringContaining(SOURCE),
    );
  });

  it('shows no review wording or controls for a file with review states off', async () => {
    stubAttachments({
      rows: [row({ reviewStates: false, shownVersionState: 'draft', hasPublicLink: true })],
    });
    renderAt(<App />, PAGE);

    const list = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(list).getByText('Contract.pdf')).toBeVisible();
    expect(within(list).queryByText('Draft')).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Approve Contract.pdf' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'State' })).toBeNull();
    await manage(userEvent.setup());
    expect(within(list).queryByRole('button', { name: 'Submit for review' })).toBeNull();
    expect(within(list).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(list).getByRole('button', { name: 'Download' })).toBeVisible();
  });

  it('sends the filters to the server', async () => {
    const calls = stubAttachments();
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Attachments' });

    await user.click(screen.getByRole('checkbox', { name: 'Show images' }));
    await user.click(screen.getByRole('checkbox', { name: 'Expiring only' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'approved');

    await waitFor(() => {
      const last = calls.filter((call) => call.path.endsWith('/attachments')).at(-1);
      expect(last?.search).toContain('includeImages=true');
      expect(last?.search).toContain('expiring=true');
      expect(last?.search).toContain('state=approved');
    });
  });

  it('submits for review and approves through the state route', async () => {
    const calls = stubAttachments();
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => {
      expect(calls.find((call) => call.path.endsWith('/state'))?.body).toEqual({
        state: 'in_review',
      });
    });
    expect(calls.find((call) => call.path.endsWith('/state'))?.path).toBe(
      `/api/v1/items/${FILE}/file/versions/${VERSION}/state`,
    );
  });

  it('asks before revoking an approved version', async () => {
    const calls = stubAttachments({ rows: [row({ shownVersionState: 'approved' })] });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(calls.some((call) => call.path.endsWith('/state'))).toBe(false);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(calls.find((call) => call.path.endsWith('/state'))?.body).toEqual({
        state: 'revoked',
      });
    });
  });

  it('sets and clears the expiry as a property write', async () => {
    const calls = stubAttachments({ rows: [row({ expiresAt: '2027-03-01T00:00:00+00:00' })] });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.clear(screen.getByLabelText('Expiry date for Contract.pdf'));
    await user.type(screen.getByLabelText('Expiry date for Contract.pdf'), '2027-04-02');
    await user.click(screen.getByRole('button', { name: 'Set expiry' }));
    await waitFor(() => {
      expect(calls.find((call) => call.path.endsWith('/properties'))?.body).toEqual({
        properties: { expiry: new Date('2027-04-02T23:59:59').toISOString() },
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Clear expiry' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith('/properties')).at(-1)?.body).toEqual({
        properties: { expiry: null },
      });
    });
  });

  it('creates a public link and shows its URL from the link route', async () => {
    const calls = stubAttachments();
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(screen.getByRole('button', { name: 'Create public link' }));
    expect(await screen.findByDisplayValue('https://example.test/public/abc')).toBeVisible();
    expect(calls.some((call) => call.method === 'PUT' && call.path.endsWith('/public-link'))).toBe(
      true,
    );
  });

  it('confirms before revoking a public link', async () => {
    const calls = stubAttachments({ rows: [row({ hasPublicLink: true })] });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(await screen.findByRole('button', { name: 'Revoke public link' }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke link' }),
    );
    await waitFor(() => {
      expect(
        calls.some((call) => call.method === 'DELETE' && call.path.endsWith('/public-link')),
      ).toBe(true);
    });
  });

  it('explains plainly when public links are turned off', async () => {
    stubAttachments({ linkStatus: 404 });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(screen.getByRole('button', { name: 'Create public link' }));
    expect(await screen.findByText(/Public links are turned off/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create public link' })).toBeNull();
  });

  it('hides the link controls, and never asks for a link, when public links are off', async () => {
    stubCoreApi({ publicLinks: false });
    const calls = stubAttachments({ rows: [row({ hasPublicLink: true })] });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    expect(await screen.findByText(/Public links are turned off/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create public link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke public link' })).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/public-link'))).toBe(false);
  });

  it('lists who points at the file and unpins through the holder', async () => {
    const calls = stubAttachments();
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    expect(await screen.findByText('Offer record (pin)')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unpin Offer record' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(
        calls.some(
          (call) =>
            call.method === 'DELETE' &&
            call.path === `/api/v1/items/${HOLDER}/references/${REFERENCE}`,
        ),
      ).toBe(true);
    });
  });

  it('approves from the row without opening Manage', async () => {
    const calls = stubAttachments();
    renderAt(<App />, PAGE);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Approve Contract.pdf' }));
    await waitFor(() => {
      expect(calls.find((call) => call.path.endsWith('/state'))?.body).toEqual({
        state: 'approved',
      });
    });
    expect(await screen.findByText('Approved “Contract.pdf”')).toBeVisible();
  });

  it('submits several selected files for review in one action, and undoes it', async () => {
    const calls = stubAttachments({
      rows: [
        row(),
        row({ itemId: SECOND, title: 'Budget.xlsx', shownVersionId: SECOND_VERSION }),
        row({
          itemId: THIRD,
          title: 'Done.pdf',
          shownVersionId: THIRD_VERSION,
          shownVersionState: 'approved',
        }),
      ],
    });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Attachments' });

    await user.click(screen.getByRole('checkbox', { name: 'Select all shown files' }));
    await user.click(await screen.findByRole('button', { name: 'Submit for review (2)' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith('/state'))).toHaveLength(2);
    });
    expect(await screen.findByText('Submitted for review: 2 files, 1 skipped')).toBeVisible();

    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      const writes = calls.filter((call) => call.path.endsWith('/state'));
      expect(writes).toHaveLength(4);
      expect(writes.slice(2).map((call) => call.body)).toEqual([
        { state: 'draft' },
        { state: 'draft' },
      ]);
    });
  });

  it('sets an expiry on the selected files and undoes it with the old value', async () => {
    const calls = stubAttachments({ rows: [row({ expiresAt: '2027-03-01T00:00:00+00:00' })] });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('checkbox', { name: 'Select Contract.pdf' }));
    await user.type(screen.getByLabelText('Expiry date for selected files'), '2027-04-02');
    await user.click(screen.getByRole('button', { name: 'Set expiry (1)' }));
    await waitFor(() => {
      expect(calls.find((call) => call.path.endsWith('/properties'))?.body).toEqual({
        properties: { expiry: new Date('2027-04-02T23:59:59').toISOString() },
      });
    });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path.endsWith('/properties')).at(-1)?.body).toEqual({
        properties: { expiry: '2027-03-01T00:00:00+00:00' },
      });
    });
  });

  it('finds the files that need attention without opening any row', async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    stubAttachments({
      rows: [
        row({ shownVersionState: 'approved', title: 'Fine.pdf' }),
        row({
          itemId: SECOND,
          title: 'Review me.pdf',
          shownVersionId: SECOND_VERSION,
          shownVersionState: 'in_review',
        }),
        row({
          itemId: THIRD,
          title: 'Lapsing.pdf',
          shownVersionId: THIRD_VERSION,
          shownVersionState: 'approved',
          expiresAt: soon,
        }),
      ],
    });
    renderAt(<App />, PAGE);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Needs attention (2)' }));
    const list = screen.getByRole('list', { name: 'Attachments' });
    expect(within(list).queryByText('Fine.pdf')).toBeNull();
    expect(within(list).getByText('Review me.pdf')).toBeVisible();
    expect(within(list).getByText('Expiring soon')).toBeVisible();
  });

  it('downloads the shown version', async () => {
    const calls = stubAttachments();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderAt(<App />, PAGE);
    const user = userEvent.setup();
    await manage(user);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith('https://files.example.test/x', '_blank', 'noopener');
    });
    expect(calls.find((call) => call.path.endsWith('/file/download'))?.search).toContain(VERSION);
  });

  it('shows the error state, with a retry, when the list is not implemented', async () => {
    stubAttachments({ listStatus: 501 });
    renderAt(<App />, PAGE);

    expect(await screen.findByText('Attachments could not be loaded')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('says so when there are no files', async () => {
    stubAttachments({ rows: [] });
    renderAt(<App />, PAGE);

    expect(await screen.findByText('No attachments')).toBeVisible();
  });
});
