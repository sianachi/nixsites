import { afterEach, describe, expect, it, vi } from 'vitest';

import { viewCommitted, withViewTransition } from '../../lib/view-transition';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
});

function reducedMotion(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reduced })),
  );
}

/** A stand-in for the browser: runs the callback and reports when its promise settles. */
function browserTransitions(): { settled: () => boolean } {
  let done = false;
  (document as { startViewTransition?: unknown }).startViewTransition = (
    callback: () => Promise<void>,
  ) => {
    void callback().then(() => {
      done = true;
    });
  };
  return { settled: () => done };
}

describe('view transitions', () => {
  it('takes the new snapshot only once the new location has committed', async () => {
    reducedMotion(false);
    const browser = browserTransitions();
    const update = vi.fn();

    withViewTransition(update);
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    expect(browser.settled()).toBe(false);

    viewCommitted();
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.settled()).toBe(true);
  });

  it('never holds the page for a change that commits no new location', async () => {
    vi.useFakeTimers();
    reducedMotion(false);
    const browser = browserTransitions();

    withViewTransition(vi.fn());
    await vi.advanceTimersByTimeAsync(250);

    expect(browser.settled()).toBe(true);
  });

  it('just runs the change for someone who asked for reduced motion', () => {
    reducedMotion(true);
    const start = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = start;
    const update = vi.fn();

    withViewTransition(update);

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it('just runs the change where the browser has no view transitions', () => {
    reducedMotion(false);
    const update = vi.fn();

    withViewTransition(update);

    expect(update).toHaveBeenCalledOnce();
  });
});
