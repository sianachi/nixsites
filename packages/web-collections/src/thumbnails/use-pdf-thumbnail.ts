import { useEffect, useRef, useState } from 'react';

import { PdfThumbnailError, renderPdfFirstPage } from './pdf-first-page';

/**
 * - `idle`: nothing asked for yet (`enabled` is false).
 * - `loading`: fetching the file or drawing it.
 * - `ready`: `url` is a picture of the first page.
 * - `none`: this file has no thumbnail and never will - too large, encrypted, damaged. Show the
 *   file-type icon, and do not offer a retry.
 * - `error`: it might work another time - the fetch failed, or drawing ran out of time.
 */
export type PdfThumbnailStatus = 'idle' | 'loading' | 'ready' | 'none' | 'error';

export interface PdfThumbnail {
  readonly status: PdfThumbnailStatus;
  readonly url: string | null;
}

export interface UsePdfThumbnailOptions {
  readonly itemId: string;

  /** Anything that changes when the file does, e.g. its byte length and last-modified stamp. */
  readonly version: string;

  /**
   * Hold this false until the card is on screen. It should latch: dropping it back to false
   * releases the picture, and showing it again requests a fresh capability.
   */
  readonly enabled: boolean;

  /** How the PDF's bytes are fetched; this module neither knows nor cares. */
  readonly load: (signal: AbortSignal) => Promise<Blob>;
}

/** The longer side of the stored thumbnail. */
const THUMBNAIL_MAX_SIDE = 480;

/**
 * Drawing a PDF is CPU work on a worker and memory on this thread, and a gallery can mount fifty
 * at once. Two at a time keeps the tab responsive; the rest wait here, in the order they asked.
 */
const MAX_CONCURRENT_RENDERS = 2;
let running = 0;
const waiting: (() => void)[] = [];

/** Resolves with the release function once a slot is free; a waiter that aborts just leaves. */
function acquireSlot(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      running -= 1;
      waiting.shift()?.();
    };
    const grant = () => {
      signal.removeEventListener('abort', onAbort);
      running += 1;
      resolve(release);
    };
    const onAbort = () => {
      const at = waiting.indexOf(grant);
      if (at >= 0) waiting.splice(at, 1);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (running < MAX_CONCURRENT_RENDERS) grant();
    else waiting.push(grant);
  });
}

interface Outcome {
  /** Which request this is the answer to, so an answer to an old one is never shown for a new. */
  readonly token: string;
  readonly status: 'ready' | 'none' | 'error';
  readonly url: string | null;
}

export function usePdfThumbnail({
  itemId,
  version,
  enabled,
  load,
}: UsePdfThumbnailOptions): PdfThumbnail {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Callers pass `load` as a closure over the file they are showing; a new identity every render
  // must not restart a render that is under way.
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  const token = `${itemId}\n${version}`;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    let objectUrl: string | null = null;

    const settle = (status: Outcome['status'], blob: Blob | null) => {
      if (signal.aborted) return;
      if (blob !== null) objectUrl = URL.createObjectURL(blob);
      setOutcome({ token, status, url: objectUrl });
    };

    void (async () => {
      // PDF pixels are body data too: fetch through Core's capability boundary on every mount.
      // Keeping them on disk would retain the body of a file later put under a lock.
      let release: (() => void) | undefined;
      try {
        release = await acquireSlot(signal);
        const bytes = await loadRef.current(signal);
        const blob = await renderPdfFirstPage(bytes, { maxSide: THUMBNAIL_MAX_SIDE, signal });
        settle('ready', blob);
      } catch (error) {
        const permanent =
          error instanceof PdfThumbnailError &&
          (error.reason === 'too-large' || error.reason === 'unreadable');
        settle(permanent ? 'none' : 'error', null);
      } finally {
        release?.();
      }
    })();

    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [itemId, version, enabled, token]);

  if (!enabled) return { status: 'idle', url: null };
  if (outcome?.token !== token) return { status: 'loading', url: null };
  return { status: outcome.status, url: outcome.url };
}
