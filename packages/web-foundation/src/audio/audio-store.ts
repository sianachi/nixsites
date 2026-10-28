import { useSyncExternalStore } from 'react';

import {
  forgetAudioPosition,
  readAudioPosition,
  rememberAudioPosition,
} from '../lib/audio-positions';

/**
 * The one audio player the application has.
 *
 * **Why a module and not a component.** The `<audio>` element is created here, once, and never
 * rendered into the tree, so playback belongs to the page and not to whichever screen started it:
 * navigating away unmounts the file viewer and the sound carries on, and the mini player in the
 * shell is only another reader of this state. A component that owned the element would stop the
 * sound on every route change, which is the whole thing this exists to avoid.
 *
 * **Where the bytes come from.** The element is handed the authorised capability URL itself and
 * streams from it with range requests, so a long recording starts at once and can seek without
 * being held in memory. Capability URLs expire, so a track carries a way to ask for a fresh one;
 * a media error triggers exactly one refresh before it is believed.
 *
 * State is replaced, never mutated, so `useSyncExternalStore` can compare snapshots by identity.
 */

export interface AudioTrack {
  readonly itemId: string;
  readonly title: string;
  readonly url: string;
}

/**
 * Why playback stopped. `unsupported` is also what a browser reports for an address that will not
 * load at all, so its copy must not claim to know the codec is the cause.
 */
export type AudioFailure = 'network' | 'unsupported';

export interface AudioState {
  readonly track: AudioTrack | null;
  readonly playing: boolean;
  /** Waiting on the network or on a fresh address; not the same as paused. */
  readonly loading: boolean;
  readonly currentTime: number;
  /** Zero until the file says how long it is. */
  readonly duration: number;
  readonly rate: number;
  readonly error: AudioFailure | null;
  /** Items whose own viewer is on screen, so the mini player knows when to stay out of the way. */
  readonly viewing: readonly string[];
}

export type FreshAudioUrl = () => Promise<string>;

const INITIAL: AudioState = {
  track: null,
  playing: false,
  loading: false,
  currentTime: 0,
  duration: 0,
  rate: 1,
  error: null,
  viewing: [],
};

/** Four updates a second is smooth for a slider and cheap for every subscriber. */
const TIME_UPDATE_INTERVAL_MS = 250;
/** A position worth writing to storage need not be written every quarter second. */
const SAVE_INTERVAL_MS = 5000;
/** Skipping is not seeking: an ended recording restarts rather than resuming its last second. */
const RESTART_WITHIN_SECONDS = 3;

let state: AudioState = INITIAL;
const listeners = new Set<() => void>();

let element: HTMLAudioElement | null = null;
let freshUrl: FreshAudioUrl | null = null;
let refreshed = false;
let wantsToPlay = false;
let pendingSeek: number | null = null;
/** Bumped whenever the track changes, so an answer to an old question is ignored. */
let generation = 0;
let lastEmit = 0;
let lastSave = 0;
const viewers = new Map<string, number>();

function update(patch: Partial<AudioState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAudioState(): AudioState {
  return state;
}

export function useAudioState(): AudioState {
  return useSyncExternalStore(subscribe, getAudioState, getAudioState);
}

function savePosition(): void {
  if (state.track === null || element === null) return;
  lastSave = Date.now();
  const at = element.currentTime;
  if (state.duration > 0 && state.duration - at < RESTART_WITHIN_SECONDS) {
    forgetAudioPosition(state.track.itemId);
    return;
  }
  rememberAudioPosition(state.track.itemId, at);
}

function mediaSession(): MediaSession | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
    ? navigator.mediaSession
    : null;
}

function describeToMediaSession(track: AudioTrack | null): void {
  const session = mediaSession();
  if (session === null) return;
  try {
    session.metadata =
      track !== null && typeof MediaMetadata !== 'undefined'
        ? new MediaMetadata({ title: track.title })
        : null;
    if (track === null) session.playbackState = 'none';
  } catch {
    // Metadata is a courtesy to the lock screen; playback does not depend on it.
  }
}

function reportPositionToMediaSession(): void {
  const session = mediaSession();
  if (session === null || element === null || !(state.duration > 0)) return;
  try {
    session.setPositionState({
      duration: state.duration,
      position: Math.min(element.currentTime, state.duration),
      playbackRate: element.playbackRate,
    });
  } catch {
    // Throws on a position outside the duration while metadata settles; the next update is right.
  }
}

function installMediaSessionHandlers(): void {
  const session = mediaSession();
  if (session === null) return;
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    [
      'play',
      () => {
        resume();
      },
    ],
    [
      'pause',
      () => {
        pause();
      },
    ],
    [
      'seekbackward',
      (details) => {
        seek(state.currentTime - (details.seekOffset ?? 15));
      },
    ],
    [
      'seekforward',
      (details) => {
        seek(state.currentTime + (details.seekOffset ?? 30));
      },
    ],
    [
      'seekto',
      (details) => {
        if (details.seekTime !== undefined) seek(details.seekTime);
      },
    ],
  ];
  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // An action this browser does not know; the others still work.
    }
  }
}

/** A rejected `play()` is either expected (a newer load interrupted it) or worth saying. */
function playRejected(reason: unknown): void {
  if (!(reason instanceof DOMException)) return;
  if (reason.name === 'AbortError') return;
  if (reason.name === 'NotAllowedError') {
    // The browser wanted a gesture it no longer trusted; the next press of play is one.
    wantsToPlay = false;
    update({ loading: false, playing: false });
  }
  // NotSupportedError arrives again as the element's own `error` event, handled there.
}

function startPlayback(el: HTMLAudioElement): void {
  wantsToPlay = true;
  el.play().catch(playRejected);
}

function load(url: string, at: number | null, play: boolean): void {
  const el = audioElement();
  pendingSeek = at;
  wantsToPlay = play;
  el.src = url;
  el.defaultPlaybackRate = state.rate;
  el.playbackRate = state.rate;
  if (play) startPlayback(el);
}

function refreshAndReload(): void {
  if (state.track === null || freshUrl === null) return;
  const mine = generation;
  const track = state.track;
  const at = element?.currentTime ?? state.currentTime;
  const play = wantsToPlay;
  update({ loading: true, error: null });
  freshUrl().then(
    (url) => {
      if (mine !== generation) return;
      update({ track: { ...track, url } });
      load(url, at, play);
    },
    () => {
      if (mine !== generation) return;
      update({ loading: false, playing: false, error: 'network' });
    },
  );
}

function onMediaError(el: HTMLAudioElement): void {
  if (state.track === null) return;
  if (!refreshed && freshUrl !== null) {
    // The commonest reason a stream breaks is an address that has expired, and a browser reports
    // that as a decode failure. Ask for a new one once before telling the person anything.
    refreshed = true;
    refreshAndReload();
    return;
  }
  wantsToPlay = false;
  update({
    playing: false,
    loading: false,
    error: el.error?.code === MediaError.MEDIA_ERR_NETWORK ? 'network' : 'unsupported',
  });
}

function audioElement(): HTMLAudioElement {
  if (element !== null) return element;
  const el = new Audio();
  el.preload = 'metadata';
  element = el;

  const duration = (): number => (Number.isFinite(el.duration) ? el.duration : 0);

  el.addEventListener('loadedmetadata', () => {
    if (pendingSeek !== null) {
      const limit = duration();
      el.currentTime = limit > 0 ? Math.min(pendingSeek, limit) : pendingSeek;
      pendingSeek = null;
    }
    update({ duration: duration(), currentTime: el.currentTime });
  });
  el.addEventListener('durationchange', () => {
    update({ duration: duration() });
  });
  el.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastEmit < TIME_UPDATE_INTERVAL_MS) return;
    lastEmit = now;
    update({ currentTime: el.currentTime });
    reportPositionToMediaSession();
    if (now - lastSave >= SAVE_INTERVAL_MS) savePosition();
  });
  el.addEventListener('seeked', () => {
    update({ currentTime: el.currentTime });
    reportPositionToMediaSession();
  });
  el.addEventListener('play', () => {
    update({ playing: true });
    const session = mediaSession();
    if (session !== null) session.playbackState = 'playing';
  });
  el.addEventListener('playing', () => {
    update({ playing: true, loading: false });
  });
  el.addEventListener('pause', () => {
    update({ playing: false });
    savePosition();
    const session = mediaSession();
    if (session !== null) session.playbackState = 'paused';
  });
  el.addEventListener('waiting', () => {
    update({ loading: true });
  });
  el.addEventListener('canplay', () => {
    refreshed = false;
    update({ loading: false });
  });
  el.addEventListener('ratechange', () => {
    update({ rate: el.playbackRate });
  });
  el.addEventListener('ended', () => {
    wantsToPlay = false;
    if (state.track !== null) forgetAudioPosition(state.track.itemId);
    update({ playing: false, currentTime: duration() });
  });
  el.addEventListener('error', () => {
    onMediaError(el);
  });

  installMediaSessionHandlers();
  return el;
}

/**
 * Plays a track from where this device last left it. Calling it for the track already loaded
 * resumes that track instead of reloading it. `fresh` asks for a new address when the one in the
 * track has expired.
 */
export function play(track: AudioTrack, fresh?: FreshAudioUrl): void {
  if (state.track?.itemId === track.itemId && state.error === null) {
    resume();
    return;
  }
  savePosition();
  generation += 1;
  freshUrl = fresh ?? null;
  refreshed = false;
  const at = readAudioPosition(track.itemId);
  update({
    track,
    playing: false,
    loading: true,
    currentTime: at ?? 0,
    duration: 0,
    error: null,
  });
  describeToMediaSession(track);
  load(track.url, at, true);
}

export function resume(): void {
  if (state.track === null || state.error !== null) return;
  startPlayback(audioElement());
}

export function pause(): void {
  wantsToPlay = false;
  element?.pause();
}

/** Moves to a time in seconds, clamped to the recording. Before metadata arrives it is remembered. */
export function seek(seconds: number): void {
  if (state.track === null || !Number.isFinite(seconds)) return;
  const el = audioElement();
  const limit = state.duration > 0 ? state.duration : Number.POSITIVE_INFINITY;
  const target = Math.min(Math.max(seconds, 0), limit);
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
    el.currentTime = target;
  } else {
    pendingSeek = target;
  }
  update({ currentTime: target });
}

export function setRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) return;
  const el = audioElement();
  el.defaultPlaybackRate = rate;
  el.playbackRate = rate;
  update({ rate });
}

/** Tries the current track again after a failure, with a fresh address when one can be had. */
export function retry(): void {
  const track = state.track;
  if (track === null) return;
  refreshed = true;
  wantsToPlay = true;
  if (freshUrl !== null) {
    refreshAndReload();
    return;
  }
  update({ loading: true, error: null });
  load(track.url, state.currentTime, true);
}

/** Stops, forgets the track and releases the file. */
export function stop(): void {
  if (element === null || state.track === null) return;
  savePosition();
  generation += 1;
  wantsToPlay = false;
  pendingSeek = null;
  freshUrl = null;
  element.pause();
  element.removeAttribute('src');
  element.load();
  describeToMediaSession(null);
  update({ ...INITIAL, rate: state.rate, viewing: state.viewing });
}

/** Declares that an item's own player is on screen. Returns the undo. */
export function registerAudioViewer(itemId: string): () => void {
  viewers.set(itemId, (viewers.get(itemId) ?? 0) + 1);
  update({ viewing: [...viewers.keys()] });
  return () => {
    const remaining = (viewers.get(itemId) ?? 1) - 1;
    if (remaining <= 0) viewers.delete(itemId);
    else viewers.set(itemId, remaining);
    update({ viewing: [...viewers.keys()] });
  };
}
