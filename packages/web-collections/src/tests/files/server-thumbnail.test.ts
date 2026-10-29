import type { NixClient } from '@nix/api-client';
import { expect, it, vi } from 'vitest';

import { forgetThumbnails, recallAuthorisedBytes } from '@nix/web-foundation/lib/thumbnail-cache';
import { loadServerThumbnail } from '../../thumbnails/server-thumbnail';

it('does not retain thumbnail bytes if sign-out happens while Core answers the capability request', async () => {
  await forgetThumbnails();
  const capability = { url: 'http://localhost:7070/thumbnail' };
  let finishCapability: (value: typeof capability) => void = () => undefined;
  const query = vi.fn().mockResolvedValue(capability);
  query.mockReturnValueOnce(
    new Promise<typeof capability>((resolve) => {
      finishCapability = resolve;
    }),
  );
  const client = { query } as unknown as NixClient;
  const download = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(new Blob(['jpeg'], { type: 'image/jpeg' }))),
    );
  vi.stubGlobal('fetch', download);
  const pending = loadServerThumbnail(client, 'file', new AbortController().signal);
  expect(query).toHaveBeenCalledOnce();
  expect(download).not.toHaveBeenCalled();

  await forgetThumbnails();
  finishCapability(capability);
  await pending;
  expect(recallAuthorisedBytes(capability.url)).toBeNull();

  await loadServerThumbnail(client, 'file', new AbortController().signal);
  expect(query).toHaveBeenCalledTimes(2);
  expect(download).toHaveBeenCalledTimes(2);
});
