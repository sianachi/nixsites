import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createNixClient, NixApiError, type NixClient } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../files/file-viewer';
import { stubViewport } from '../stub-viewport';

let client: NixClient;
const revokeObjectURL = vi.fn();

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
}));

const ITEM = 'a1111111-1111-4111-8111-111111111111';
const VERSION = 'a2222222-2222-4222-8222-222222222222';

function record(previewable: boolean, mediaType = 'image/png') {
  const current = {
    id: VERSION,
    version: 1,
    fileName: mediaType === 'application/pdf' ? 'document.pdf' : 'diagram.png',
    mediaType,
    byteLength: 7,
    sha256: '1'.repeat(64),
    previewable,
    pixelWidth: previewable ? 40 : null,
    pixelHeight: previewable ? 20 : null,
    createdAt: '2026-09-01T00:00:00Z',
    current: true,
  };
  return {
    itemId: ITEM,
    workspaceId: 'a3333333-3333-4333-8333-333333333333',
    current,
    versions: [current],
  };
}

function fakeClient(previewable: boolean, mediaType = 'image/png'): NixClient {
  return {
    cache: createNixClient({
      baseUrl: 'http://localhost',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }).cache,
    query: vi.fn((endpoint: { operation: string }) => {
      if (endpoint.operation === 'files.get')
        return Promise.resolve(record(previewable, mediaType));
      if (endpoint.operation === 'files.download') {
        return Promise.resolve({
          url: 'http://localhost:9447/preview',
          expiresAt: '2026-09-01T00:10:00Z',
          fileName: mediaType === 'application/pdf' ? 'document.pdf' : 'diagram.png',
          mediaType,
          byteLength: 7,
          sha256: '1'.repeat(64),
          inline: true,
          unscanned: true,
          noSniff: true,
        });
      }
      return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
    }),
  } as unknown as NixClient;
}

beforeEach(() => {
  stubViewport(true);
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:nix-preview'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectURL.mockClear(),
  });
});

describe('the file item viewer', () => {
  it('shows opaque files without a safety warning and does not fetch preview bytes', async () => {
    client = fakeClient(false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    render(<FileViewer itemId={ITEM} />);

    expect(screen.queryByText(/unscanned attachment/i)).not.toBeInTheDocument();
    // Named twice: once in the bar, once on the placard that stands in for a preview.
    expect(await screen.findAllByText('diagram.png')).toHaveLength(2);
    expect(screen.getByText(/no preview for this kind of file/i)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('holds the item controls it is given in its own bar, beside File info', async () => {
    // On a phone the page hands a file its Details and item actions to carry, instead of drawing
    // a row of their own under the title. Two buttons called "Details" would be a guess, which is
    // why the file's own drawer is "File info".
    client = fakeClient(false);
    vi.stubGlobal('fetch', vi.fn());

    render(
      <FileViewer
        itemId={ITEM}
        itemControls={
          <button type="button" aria-expanded={false}>
            Details
          </button>
        }
      />,
    );
    await screen.findAllByText('diagram.png');

    expect(screen.getByRole('button', { name: 'File info' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
  });

  it('keeps the facts and the versions in a drawer behind one button', async () => {
    client = fakeClient(false);
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();

    render(<FileViewer itemId={ITEM} />);
    await screen.findAllByText('diagram.png');

    // The checksum is not on the page until asked for.
    expect(screen.queryByText('1'.repeat(64))).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'File details' })).not.toBeInTheDocument();

    const details = screen.getByRole('button', { name: 'File info' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    await user.click(details);

    const drawer = screen.getByRole('complementary', { name: 'File details' });
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(within(drawer).getByText('1'.repeat(64))).toBeVisible();
    expect(within(drawer).getByText('Version 1')).toBeVisible();
    expect(within(drawer).getByText('Current')).toBeVisible();
    expect(within(drawer).getByRole('button', { name: 'Download version 1' })).toBeEnabled();

    await user.click(details);
    expect(screen.queryByRole('complementary', { name: 'File details' })).not.toBeInTheDocument();
  });

  it('offers file actions from the content and keeps tablet details over the preview', async () => {
    stubViewport(768);
    client = fakeClient(false);
    vi.stubGlobal('fetch', vi.fn());
    const user = userEvent.setup();
    render(<FileViewer itemId={ITEM} />);
    await screen.findAllByText('diagram.png');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Download 7 B' }));
    const menu = screen.getByRole('menu', { name: 'File actions' });
    expect(within(menu).getByRole('menuitem', { name: 'Download' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Replace file' })).toBeEnabled();
    await user.click(within(menu).getByRole('menuitem', { name: 'File info' }));

    const dialog = screen.getByRole('dialog', { name: 'File details' });
    expect(within(dialog).getByText('Version 1')).toBeVisible();
    expect(screen.queryByRole('complementary', { name: 'File details' })).not.toBeInTheDocument();
  });

  it('names the file and its kind in the bar', async () => {
    client = fakeClient(true, 'application/pdf');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('payload', { status: 200 }))),
    );

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByText('PDF · 7 B')).toBeVisible();
  });

  it('shows a loading state until the authorized image bytes become available', async () => {
    client = fakeClient(true);
    let release: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByRole('status')).toHaveTextContent(/loading the authorized preview/i);
    // Loading starts before the capability lookup completes and fetch has a resolver to release.
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.(new Response('payload', { status: 200, headers: { 'content-type': 'image/png' } }));
    expect(await screen.findByRole('img', { name: 'diagram.png' })).toHaveAttribute(
      'src',
      'blob:nix-preview',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders an authorized PDF preview inline', async () => {
    client = fakeClient(true, 'application/pdf');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('payload', {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          }),
        ),
      ),
    );

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByTitle('document.pdf')).toHaveAttribute('src', 'blob:nix-preview');
  });

  it('keeps download available when an authorized preview is refused', async () => {
    client = fakeClient(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 403 }))),
    );

    render(<FileViewer itemId={ITEM} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/preview is unavailable/i);
    expect(screen.getAllByRole('button', { name: 'Download' })[0]).toBeEnabled();
  });

  it.each([403, 404, 423])(
    'removes previous file metadata and preview when a refresh returns %s',
    async (status) => {
      client = fakeClient(true);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('payload', { status: 200 }))),
      );
      const user = userEvent.setup();

      render(<FileViewer itemId={ITEM} />);
      expect(await screen.findByRole('img', { name: 'diagram.png' })).toHaveAttribute(
        'src',
        'blob:nix-preview',
      );
      await user.click(screen.getByRole('button', { name: 'File info' }));
      expect(screen.getByText('1'.repeat(64))).toBeVisible();

      vi.spyOn(client, 'query').mockRejectedValueOnce(
        NixApiError.fromStatus(status, 'This file is no longer available.'),
      );
      act(() => {
        client.cache.invalidatePrefix(['files', ITEM]);
      });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This file is no longer available.',
      );
      expect(screen.queryByRole('region', { name: 'File' })).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: 'diagram.png' })).not.toBeInTheDocument();
      expect(screen.queryByText('diagram.png')).not.toBeInTheDocument();
      expect(screen.queryByText('1'.repeat(64))).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:nix-preview');
    },
  );

  it('retains the previous file metadata and preview when a refresh temporarily fails', async () => {
    client = fakeClient(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('payload', { status: 200 }))),
    );

    render(<FileViewer itemId={ITEM} />);
    const preview = await screen.findByRole('img', { name: 'diagram.png' });
    vi.spyOn(client, 'query').mockRejectedValueOnce(
      NixApiError.fromStatus(503, 'The server is temporarily unavailable.'),
    );
    act(() => {
      client.cache.invalidatePrefix(['files', ITEM]);
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server is temporarily unavailable.',
    );
    expect(screen.getByText('diagram.png')).toBeVisible();
    expect(screen.getByRole('img', { name: 'diagram.png' })).toBe(preview);
    expect(preview).toHaveAttribute('src', 'blob:nix-preview');
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });
});
