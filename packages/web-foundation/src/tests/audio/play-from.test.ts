import type { NixClient } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { playRecordingFrom } from '../../audio/play-from';

const AUDIO = 'b1000000-0000-4000-8000-000000000001';
const store = vi.hoisted(() => ({
  track: null as { itemId: string } | null,
  play: vi.fn(),
  seek: vi.fn(),
  resume: vi.fn(),
  url: vi.fn(),
}));
vi.mock('../../audio/audio-store', () => ({
  getAudioState: () => ({ track: store.track }),
  play: store.play,
  seek: store.seek,
  resume: store.resume,
}));
vi.mock('../../audio/audio-source', () => ({ authorisedAudioUrl: store.url }));

const client = {
  query: vi.fn(() => Promise.resolve({ current: { fileName: 'Meeting 2026-10-05 14.30.weba' } })),
} as unknown as NixClient;

beforeEach(() => {
  store.track = null;
  for (const mock of [store.play, store.seek, store.resume]) mock.mockReset();
  store.url.mockReset().mockResolvedValue('https://files.example/recording');
});

describe('playing a recording from a transcript line', () => {
  it('loads the recording in the shared player and starts at that moment', async () => {
    await playRecordingFrom(client, AUDIO, 754);

    expect(store.play).toHaveBeenCalledWith(
      {
        itemId: AUDIO,
        title: 'Meeting 2026-10-05 14.30.weba',
        url: 'https://files.example/recording',
      },
      expect.any(Function),
    );
    expect(store.seek).toHaveBeenCalledWith(754);
    // The player can ask for a fresh address when this one expires.
    const fresh = store.play.mock.calls[0]?.[1] as () => Promise<string>;
    await expect(fresh()).resolves.toBe('https://files.example/recording');
  });

  it('moves a recording that is already loaded rather than loading it again', async () => {
    store.track = { itemId: AUDIO };

    await playRecordingFrom(client, AUDIO, 30);

    expect(store.seek).toHaveBeenCalledWith(30);
    expect(store.resume).toHaveBeenCalledOnce();
    expect(store.play).not.toHaveBeenCalled();
    expect(store.url).not.toHaveBeenCalled();
  });
});
