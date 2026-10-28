import { NixApiError } from '@nix/api-client';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetThumbnails } from '@nix/web-foundation/lib/thumbnail-cache';
import { fileImageReference } from '../../../properties/inputs/image-reference';
import { CoverImage } from '../../../views/gallery/cover-image';

const client = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => client,
}));

const ITEM = '55555555-5555-4555-8555-555555555555';
const THUMBNAIL = `/api/v1/items/${ITEM}/file/thumbnail`;
const DOWNLOAD = `/api/v1/items/${ITEM}/file/download`;

function asked(path: string): number {
  return client.query.mock.calls.filter(
    ([endpoint]) => (endpoint as { path: string }).path === path,
  ).length;
}

function answer(thumbnail: 'present' | 'absent'): void {
  client.query.mockImplementation((endpoint: { path: string }) => {
    if (endpoint.path === THUMBNAIL) {
      return thumbnail === 'present'
        ? Promise.resolve({ url: 'http://localhost:7070/objects/thumbnail?signature=a' })
        : Promise.reject(NixApiError.fromStatus(404));
    }
    return Promise.resolve({ url: 'http://localhost:7070/objects/original', byteLength: 8 });
  });
}

beforeEach(async () => {
  await forgetThumbnails();
  client.query.mockReset();
  let minted = 0;
  Object.assign(URL, {
    createObjectURL: vi.fn(() => {
      minted += 1;
      return `blob:picture-${String(minted)}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  vi.mocked(fetch).mockReset();
  // A string body, so the byte count the download check compares is the text's own length.
  vi.mocked(fetch).mockImplementation((input) =>
    Promise.resolve(
      new Response(
        (input instanceof URL ? input.href : '').includes('original') ? 'original' : 'tiny',
        {
          headers: { 'Content-Type': 'image/jpeg' },
        },
      ),
    ),
  );
});

describe('an uploaded cover', () => {
  it('is drawn from its stored thumbnail without downloading the file', async () => {
    answer('present');
    const onError = vi.fn();
    const view = render(<CoverImage src={fileImageReference(ITEM)} alt="" onError={onError} />);
    await waitFor(() => {
      expect(view.container.querySelector('img')).not.toBeNull();
    });
    expect(asked(THUMBNAIL)).toBe(1);
    expect(asked(DOWNLOAD)).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('falls back to the file when it has no thumbnail', async () => {
    answer('absent');
    const onError = vi.fn();
    const view = render(<CoverImage src={fileImageReference(ITEM)} alt="" onError={onError} />);
    await waitFor(() => {
      expect(view.container.querySelector('img')).not.toBeNull();
    });
    expect(asked(DOWNLOAD)).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('replaces the thumbnail with the file in a frame too wide for one', async () => {
    answer('present');
    const view = render(
      <CoverImage src={fileImageReference(ITEM)} alt="" sharp onError={vi.fn()} />,
    );
    await waitFor(() => {
      expect(asked(THUMBNAIL)).toBe(1);
      expect(asked(DOWNLOAD)).toBe(1);
      expect(view.container.querySelector('img')).not.toBeNull();
    });
  });

  it('reports failure only when neither picture can be had', async () => {
    client.query.mockRejectedValue(NixApiError.fromStatus(404));
    const onError = vi.fn();
    render(<CoverImage src={fileImageReference(ITEM)} alt="" onError={onError} />);
    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
