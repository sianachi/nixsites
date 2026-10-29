import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PaneViewport } from '../../layout/pane-viewport';

/** The pane div itself carries no role to query by - it is a scroller, not a control. */
function findPane(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-pane-viewport]');
  if (found === null) {
    throw new Error('Expected the harness to have rendered a pane viewport.');
  }
  return found;
}

/** Stands in for the real geometry jsdom never lays out: `scrollHeight`/`clientHeight` are
 * both always 0 there, so a test that cares about "is `target` reachable yet" has to set them
 * itself. */
function setGeometry(
  pane: HTMLElement,
  { scrollHeight, clientHeight }: { readonly scrollHeight: number; readonly clientHeight: number },
): void {
  Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(pane, 'clientHeight', { configurable: true, value: clientHeight });
}

/** Captures the observer callback so a test can fire it the way a real resize would. */
function stubResizeObserver(): {
  readonly fire: () => void;
  readonly disconnect: ReturnType<typeof vi.fn>;
} {
  const disconnect = vi.fn();
  let callback: ResizeObserverCallback | null = null;
  class RecordingResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe(): void {
      // Nothing to record - the harness drives geometry directly.
    }
    disconnect(): void {
      disconnect();
    }
  }
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  return {
    fire: () => {
      callback?.([], null as unknown as ResizeObserver);
    },
    disconnect,
  };
}

describe('PaneViewport scroll restore', () => {
  it('retries the restore once the ResizeObserver reports the pane grew tall enough', () => {
    // First mount stands in for "last time this pane was open": scroll it, then unmount, which
    // is what actually writes the position `positions` map the next mount reads from. Left off
    // `ResizeObserver` entirely - this mount's own retry loop is not what the test is about, and
    // sharing one spy across two independent effect lifecycles would count both.
    const first = render(
      <PaneViewport className="" scrollKey="note-1">
        content
      </PaneViewport>,
    );
    const firstPane = findPane(first.container);
    setGeometry(firstPane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(firstPane, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 600,
    });
    fireEvent.scroll(firstPane);
    first.unmount();

    const { fire, disconnect } = stubResizeObserver();

    // Second mount is the one under test: content has not arrived yet, so the pane is too
    // short for 600 to be a reachable scrollTop.
    const second = render(
      <PaneViewport className="" scrollKey="note-1">
        content
      </PaneViewport>,
    );
    const pane = findPane(second.container);
    setGeometry(pane, { scrollHeight: 200, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    expect(pane.scrollTop).toBe(0);

    // Content grows, but still not enough room - the observer must not settle early.
    act(() => {
      setGeometry(pane, { scrollHeight: 500, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(0);
    expect(disconnect).not.toHaveBeenCalled();

    // Content finally grows past the saved position - the retry lands it and stops watching.
    act(() => {
      setGeometry(pane, { scrollHeight: 900, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(600);
    expect(disconnect).toHaveBeenCalled();

    second.unmount();
  });

  it('stops retrying once the person scrolls the pane themselves', () => {
    const first = render(
      <PaneViewport className="" scrollKey="note-2">
        content
      </PaneViewport>,
    );
    const firstPane = findPane(first.container);
    setGeometry(firstPane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(firstPane, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 600,
    });
    fireEvent.scroll(firstPane);
    first.unmount();

    const { fire, disconnect } = stubResizeObserver();

    const second = render(
      <PaneViewport className="" scrollKey="note-2">
        content
      </PaneViewport>,
    );
    const pane = findPane(second.container);
    setGeometry(pane, { scrollHeight: 200, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    // The person scrolls away on purpose before the content ever caught up to 600.
    act(() => {
      pane.scrollTop = 50;
      fireEvent.scroll(pane);
    });
    expect(disconnect).toHaveBeenCalled();

    // Content keeps growing well past 600, but the observer already gave up - the deliberate
    // scroll must not be dragged back to the stale target.
    act(() => {
      setGeometry(pane, { scrollHeight: 900, clientHeight: 200 });
      fire();
    });
    expect(pane.scrollTop).toBe(50);

    second.unmount();
  });
});

describe('PaneViewport scroll persistence', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  /** Mounts, sets a scrollable geometry and a scroll offset, then unmounts - the sequence that
   * writes a position into the module map (and, once mounted under a workspace path, into
   * `sessionStorage`) without depending on this file's restore-retry machinery. */
  function scrollAndUnmount(scrollKey: string, scrollTop: number): void {
    const rendered = render(
      <PaneViewport className="" scrollKey={scrollKey}>
        content
      </PaneViewport>,
    );
    const pane = findPane(rendered.container);
    setGeometry(pane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', {
      configurable: true,
      writable: true,
      value: scrollTop,
    });
    fireEvent.scroll(pane);
    rendered.unmount();
  }

  it('restores a scroll position from sessionStorage across a fresh module-level map', () => {
    window.history.pushState({}, '', '/w/workspace-a/note-1');
    scrollAndUnmount('restore-key', 400);

    expect(sessionStorage.getItem('nix.pane-scroll:workspace-a')).not.toBeNull();

    // A reload does not re-evaluate this module's `positions` map from scratch in a test the way
    // a real page load would, so the restore path is exercised the same way the module itself
    // would notice storage: through a workspace change, which is the one thing that makes this
    // module re-read it.
    window.history.pushState({}, '', '/w/workspace-other/note-1');
    scrollAndUnmount('unrelated', 0);
    window.history.pushState({}, '', '/w/workspace-a/note-1');

    const { fire } = stubResizeObserver();
    const rendered = render(
      <PaneViewport className="" scrollKey="restore-key">
        content
      </PaneViewport>,
    );
    const pane = findPane(rendered.container);
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    act(() => {
      setGeometry(pane, { scrollHeight: 800, clientHeight: 200 });
      fire();
    });

    expect(pane.scrollTop).toBe(400);
    rendered.unmount();
  });

  it('ignores corrupt storage and starts fresh rather than throwing', () => {
    window.history.pushState({}, '', '/w/workspace-corrupt/note-1');
    sessionStorage.setItem('nix.pane-scroll:workspace-corrupt', 'not even json');

    expect(() => {
      const rendered = render(
        <PaneViewport className="" scrollKey="any-key">
          content
        </PaneViewport>,
      );
      rendered.unmount();
    }).not.toThrow();
  });

  it('never restores another workspace’s scroll positions', () => {
    window.history.pushState({}, '', '/w/workspace-x/note-1');
    scrollAndUnmount('shared-key', 777);

    window.history.pushState({}, '', '/w/workspace-y/note-1');
    const rendered = render(
      <PaneViewport className="" scrollKey="shared-key">
        content
      </PaneViewport>,
    );
    const pane = findPane(rendered.container);
    setGeometry(pane, { scrollHeight: 800, clientHeight: 200 });
    Object.defineProperty(pane, 'scrollTop', { configurable: true, writable: true, value: 0 });

    expect(pane.scrollTop).toBe(0);
    rendered.unmount();
  });

  it('caps the remembered positions, dropping the oldest once the limit is exceeded', () => {
    window.history.pushState({}, '', '/w/workspace-cap/note-1');

    for (let index = 0; index < 51; index += 1) {
      scrollAndUnmount(`key-${String(index)}`, index + 1);
    }

    const stored = sessionStorage.getItem('nix.pane-scroll:workspace-cap');
    expect(stored).not.toBeNull();
    const entries = JSON.parse(stored ?? '[]') as [string, number][];
    expect(entries.length).toBeLessThanOrEqual(50);
    expect(entries.some(([key]) => key === 'key-0')).toBe(false);
    expect(entries.some(([key]) => key === 'key-50')).toBe(true);
  });

  it('coalesces a burst of scroll events into a single storage write', () => {
    vi.useFakeTimers();
    try {
      window.history.pushState({}, '', '/w/workspace-coalesce/note-1');
      const rendered = render(
        <PaneViewport className="" scrollKey="coalesce-key">
          content
        </PaneViewport>,
      );
      const pane = findPane(rendered.container);
      setGeometry(pane, { scrollHeight: 800, clientHeight: 200 });
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 0,
      });

      // `sessionStorage` is a jsdom legacy-platform-object: it enforces its interface through the
      // prototype it exposes on the instance rather than through `Storage.prototype` by identity,
      // and reassigning the instance's own `setItem` is silently ignored. Spying on that exposed
      // prototype is the one shape that is actually observable.
      const setItem = vi.spyOn(Object.getPrototypeOf(sessionStorage) as Storage, 'setItem');

      // Many scroll events in quick succession - a fast fling, dozens of times a second.
      for (let scrollTop = 1; scrollTop <= 40; scrollTop += 1) {
        Object.defineProperty(pane, 'scrollTop', { configurable: true, value: scrollTop });
        fireEvent.scroll(pane);
      }
      expect(setItem).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(setItem).toHaveBeenCalledTimes(1);
      const stored = sessionStorage.getItem('nix.pane-scroll:workspace-coalesce');
      const entries = JSON.parse(stored ?? '[]') as [string, number][];
      expect(entries.find(([key]) => key === 'coalesce-key')?.[1]).toBe(40);

      rendered.unmount();
      setItem.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes the latest position on unmount even before the debounce elapses', () => {
    vi.useFakeTimers();
    try {
      window.history.pushState({}, '', '/w/workspace-flush/note-1');
      const rendered = render(
        <PaneViewport className="" scrollKey="flush-key">
          content
        </PaneViewport>,
      );
      const pane = findPane(rendered.container);
      setGeometry(pane, { scrollHeight: 800, clientHeight: 200 });
      Object.defineProperty(pane, 'scrollTop', {
        configurable: true,
        writable: true,
        value: 321,
      });
      fireEvent.scroll(pane);

      // Unmount happens well inside the debounce window - nothing has flushed on its own yet.
      rendered.unmount();

      const stored = sessionStorage.getItem('nix.pane-scroll:workspace-flush');
      expect(stored).not.toBeNull();
      const entries = JSON.parse(stored ?? '[]') as [string, number][];
      expect(entries.find(([key]) => key === 'flush-key')?.[1]).toBe(321);
    } finally {
      vi.useRealTimers();
    }
  });
});
