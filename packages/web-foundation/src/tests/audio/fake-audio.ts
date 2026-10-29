import { vi } from 'vitest';

/**
 * A stand-in for the `<audio>` element the store creates. jsdom's element has no media pipeline:
 * `play()` throws "not implemented" and no event ever fires on its own. This one records what the
 * store asked of it and lets a test fire the events a browser would, so the store's reactions can
 * be asserted without pretending to decode anything.
 */
export class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];

  src = '';
  preload = '';
  currentTime = 0;
  duration = Number.NaN;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  error: { code: number } | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn(() => {
    this.fire('pause');
  });
  load = vi.fn();

  constructor() {
    super();
    FakeAudio.instances.push(this);
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  /** Metadata arrives: the file says how long it is and can be seeked. */
  loadMetadata(duration: number): void {
    this.duration = duration;
    this.readyState = HTMLMediaElement.HAVE_METADATA;
    this.fire('loadedmetadata');
  }
}
