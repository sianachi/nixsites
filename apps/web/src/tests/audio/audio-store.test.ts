import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudio } from './fake-audio';
import type * as AudioStore from '@nix/web-foundation/audio/audio-store';
import { memoryStorage } from '../memory-storage';
import { readAudioPosition, rememberAudioPosition } from '@nix/web-foundation/lib/audio-positions';

let store: typeof AudioStore;
const track = { itemId: 'recording', title: 'Recording', url: 'https://files.example.test/one' };

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('localStorage', memoryStorage());
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('MediaError', { MEDIA_ERR_NETWORK: 2 });
  store = await import('@nix/web-foundation/audio/audio-store');
});
afterEach(() => {
  store.stop();
  vi.unstubAllGlobals();
});

function element(): FakeAudio {
  const instance = FakeAudio.instances[0];
  if (!instance) throw new Error('Playback did not create an audio element');
  return instance;
}

describe('audio playback across navigation', () => {
  it('uses one media element and keeps playing when the viewer unmounts', () => {
    const unregister = store.registerAudioViewer(track.itemId);
    store.play(track);
    element().loadMetadata(120);
    element().fire('playing');
    unregister();
    expect(store.getAudioState()).toMatchObject({ playing: true, viewing: [], duration: 120 });
    store.play({ ...track, itemId: 'second' });
    expect(FakeAudio.instances).toHaveLength(1);
  });

  it('resumes the saved position after metadata arrives and clamps seeks', () => {
    rememberAudioPosition(track.itemId, 40);
    store.play(track);
    element().loadMetadata(60);
    expect(element().currentTime).toBe(40);
    store.seek(900);
    expect(element().currentTime).toBe(60);
    store.seek(-5);
    expect(element().currentTime).toBe(0);
  });

  it('remembers a seek made before metadata arrives', () => {
    store.play(track);
    store.seek(80);
    element().loadMetadata(50);
    expect(store.getAudioState().currentTime).toBe(50);
  });

  it('refreshes an expired capability once and keeps the playback position', async () => {
    const fresh = vi.fn(() => Promise.resolve('https://files.example.test/two'));
    store.play(track, fresh);
    element().loadMetadata(120);
    store.seek(42);
    element().fire('error');
    await vi.waitFor(() => {
      expect(element().src).toBe('https://files.example.test/two');
    });
    element().loadMetadata(120);
    expect(element().currentTime).toBe(42);
    element().error = { code: 2 };
    element().fire('error');
    expect(fresh).toHaveBeenCalledOnce();
    expect(store.getAudioState().error).toBe('network');
  });

  it('ignores a capability refresh that finishes after playback has stopped', async () => {
    let resolveUrl: ((url: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    store.play(track, () => pending);
    element().fire('error');
    store.stop();
    resolveUrl?.('https://files.example.test/late');
    await pending;
    expect(store.getAudioState().track).toBeNull();
    expect(element().src).toBe('');
  });

  it('forgets the position when a recording ends', () => {
    rememberAudioPosition(track.itemId, 15);
    store.play(track);
    element().loadMetadata(60);
    element().currentTime = 60;
    element().fire('ended');
    expect(readAudioPosition(track.itemId)).toBeNull();
    expect(store.getAudioState()).toMatchObject({ playing: false, currentTime: 60 });
  });

  it('releases media bytes and saves a resumable position on stop', () => {
    store.play(track);
    element().loadMetadata(120);
    store.seek(25);
    store.stop();
    expect(element().src).toBe('');
    expect(element().load).toHaveBeenCalledOnce();
    expect(readAudioPosition(track.itemId)).toBe(25);
  });
});
