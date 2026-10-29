import { createNixClient } from '@nix/api-client';
import { describe, expect, it, vi } from 'vitest';
import { authorisedAudioUrl } from '../../audio/audio-source';

function source(url: string) {
  const client = createNixClient({
    baseUrl: 'https://core.example.test',
    tokens: {
      getAccessToken: () => Promise.resolve('test-token'),
      refreshAccessToken: () => Promise.resolve('test-token'),
    },
  });
  const query = vi.spyOn(client, 'query').mockResolvedValue({ url });
  return { client, query };
}

describe('audio capabilities', () => {
  it.each([
    'https://files.example.test/audio',
    'http://localhost:7070/audio',
    'http://[::1]:7070/audio',
  ])('streams an authorized address %s', async (url) => {
    const { client, query } = source(url);
    expect(await authorisedAudioUrl(client, 'file')).toBe(url);
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v1/items/file/file/download' }),
      expect.objectContaining({ forceRefresh: true }),
    );
  });
  it.each([
    'http://files.example.test/audio',
    'ftp://localhost/audio',
    'https://person:secret@files.example.test/audio',
  ])('refuses an unsafe address %s', async (url) => {
    const { client } = source(url);
    await expect(authorisedAudioUrl(client, 'file')).rejects.toThrow(TypeError);
  });
});
