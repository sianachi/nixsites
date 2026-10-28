import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { ConfirmLaunch } from '@nix/web-workspaces/launch/launch-page';
import { STUB_WORKSPACE, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { requestUrl } from '../request-url';

/**
 * The installed app's launch addresses, driven through the address bar exactly as a shortcut, the
 * share sheet or an opened file would reach them.
 */

function Where() {
  const location = useLocation();
  return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
}

function renderLaunch(url: string): void {
  renderAt(
    <>
      <App />
      <Where />
    </>,
    url,
  );
}

function location(): string {
  return screen.getByRole('status', { name: 'Location' }).textContent;
}

/**
 * Records what the page wrote: item creations sent to Core, and body writes sent to the
 * collaboration service - which the Core stub does not serve, so those are answered here.
 */
function recordWrites(): { readonly creates: string[]; readonly bodies: string[] } {
  const creates: string[] = [];
  const bodies: string[] = [];
  const core = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (/\/collab\/documents\/[^/]+\/updates$/u.test(url)) {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.endsWith('/items') && method === 'POST') creates.push(url);
    return core(input, init);
  });
  return { creates, bodies };
}

beforeEach(() => {
  signedIn();
});

describe('launching the installed app', () => {
  it('lets a keyboard user review all shared text before saving or cancelling', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const text = `${'A line in the shared draft.\n'.repeat(20)}The final line.`;
    render(
      <ConfirmLaunch
        intent={{ kind: 'share', title: 'Shared draft', text, url: null }}
        workspaceName="Writing"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const preview = screen.getByRole('region', { name: 'Shared text' });
    expect(preview).toHaveTextContent('The final line.');
    await user.tab();
    expect(preview).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save note' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledOnce();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('opens today from the Today shortcut', async () => {
    stubCoreApi();
    renderLaunch('/launch/today');

    await waitFor(() => {
      expect(location()).toBe(`/w/${STUB_WORKSPACE.id}/daily`);
    });
  });

  it('opens search over the workspace from the Search shortcut', async () => {
    stubCoreApi();
    renderLaunch('/launch/search');

    expect(await screen.findByRole('dialog', { name: /search/i })).toBeInTheDocument();
    expect(location()).toBe(`/w/${STUB_WORKSPACE.id}`);
  });

  it('creates a note from the New note shortcut only once asked, then opens it', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const writes = recordWrites();
    renderLaunch('/launch/new');

    expect(await screen.findByRole('heading', { name: /create a note in/i })).toBeInTheDocument();
    expect(writes.creates).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Create note' }));

    await waitFor(() => {
      expect(location()).toMatch(new RegExp(`^/w/${STUB_WORKSPACE.id}\\?item=`, 'u'));
    });
  });

  it('writes nothing when a link lands on the share address, until the person saves it', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const writes = recordWrites();
    renderLaunch(
      '/launch/share?title=Reading&text=Worth%20a%20look&url=https%3A%2F%2Fexample.com%2Fa&utm=x',
    );

    const preview = await screen.findByRole('group', { name: 'What will be saved' });
    expect(preview).toHaveTextContent('Reading');
    expect(preview).toHaveTextContent('Worth a look');
    expect(preview).toHaveTextContent('https://example.com/a');
    expect(writes.creates).toHaveLength(0);
    expect(writes.bodies).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Save note' }));

    await waitFor(() => {
      expect(location()).toMatch(new RegExp(`^/w/${STUB_WORKSPACE.id}\\?item=`, 'u'));
    });
    expect(writes.bodies).toHaveLength(1);
  });

  it('leaves the workspace untouched when the person cancels a share', async () => {
    const user = userEvent.setup();
    stubCoreApi();
    const writes = recordWrites();
    renderLaunch('/launch/share?text=Spam');

    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => {
      expect(location()).toBe(`/w/${STUB_WORKSPACE.id}`);
    });
    expect(writes.creates).toHaveLength(0);
  });

  it('explains a file launch that arrived without a file', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (globalThis as { launchQueue?: unknown }).launchQueue = { setConsumer: vi.fn() };
    stubCoreApi();
    renderLaunch('/launch/open');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no markdown file arrived/i);
    delete (globalThis as { launchQueue?: unknown }).launchQueue;
    vi.useRealTimers();
  });

  it('goes to the workspace for an action it does not know', async () => {
    stubCoreApi();
    renderLaunch('/launch/format-disk');

    await waitFor(() => {
      expect(location()).toBe(`/w/${STUB_WORKSPACE.id}`);
    });
  });
});
