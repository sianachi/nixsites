import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { App } from '../../app';

/** Captures the observer callback so a test can fire it the way a real resize would, the same
 * harness `pane-viewport.test.tsx` uses for its own `ResizeObserver` stub. */
function stubResizeObserver(): { readonly fire: () => void } {
  let callback: ResizeObserverCallback | null = null;
  class RecordingResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe(): void {
      // Nothing to record - the harness drives geometry directly.
    }
    disconnect(): void {
      // Nothing to record.
    }
  }
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  return {
    fire: () => {
      callback?.([], null as unknown as ResizeObserver);
    },
  };
}

const NOTE = item({ id: '2e2e2e2e-2222-4222-8222-2e2e2e2e2e2e', title: 'Nav height note' });

beforeEach(() => {
  signedIn();
  stubCoreApi({ items: [NOTE] });
});

describe('the mobile nav height variable', () => {
  it('publishes --mobile-nav-height while the bottom navigation shows and updates it on resize', async () => {
    const resizeObserver = stubResizeObserver();
    stubViewport(390);
    const view = renderAt(<App />, `/?item=${NOTE.id}`);

    const nav = await screen.findByRole('navigation', { name: 'Mobile navigation' });
    const region = nav.parentElement;
    if (!region) throw new Error('Expected the nav to be wrapped by the measured region.');

    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue({
      width: 390,
      height: 64,
      top: 780,
      left: 0,
      right: 390,
      bottom: 844,
      x: 0,
      y: 780,
      toJSON: () => ({}),
    });
    resizeObserver.fire();

    await waitFor(() => {
      expect(document.documentElement.style.getPropertyValue('--mobile-nav-height')).toBe('64px');
    });

    // Removed, not left stale, once the nav is torn down (a wide screen, the keyboard covering
    // it, or - as exercised here - the whole shell unmounting).
    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--mobile-nav-height')).toBe('');
  });

  it('never publishes --mobile-nav-height when the bottom navigation is not rendered', async () => {
    stubViewport(true);
    renderAt(<App />, `/?item=${NOTE.id}`);

    await screen.findByRole('textbox', { name: 'Note title' });
    expect(screen.queryByRole('navigation', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue('--mobile-nav-height')).toBe('');
  });
});
