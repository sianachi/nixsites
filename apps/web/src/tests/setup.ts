import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';

import { stubCoreApi } from './api-stub';
import { stubViewport } from './stub-viewport';
import { resetAnnouncements } from '../a11y/announcer';
import { resetSession } from './render-with-router';
import { browserStorage, browserSessionStorage } from '../lib/browser-storage';

/**
 * jsdom implements `<dialog>` as far as its `open` attribute and stops: `showModal` and `close` do
 * not exist there. Anything in this application that opens a modal - the schema editor, the view
 * editor - would throw on render without them. The shim supplies exactly those two methods, which
 * lets a test exercise what a component does with a dialog without pretending to have tested the
 * top layer, the backdrop or the focus trap; those belong to the library's own stories, which run
 * in a real browser.
 *
 * Guarded, because this file is the whole app's setup and not every suite wants a DOM: a test that
 * declares `@vitest-environment node` - compiling a stylesheet, say - has no HTMLDialogElement to
 * patch and would otherwise fail here before running a line of its own.
 */
/**
 * A media query, which jsdom does not implement at all.
 *
 * Not a convenience. Without it, every render that asks whether the window can hold a second pane
 * throws - and the failure surfaces as an unrelated element missing from the page, which is a long
 * way from anything about media queries. Wide by default, so the suite exercises the arrangement
 * the address actually asks for; a test about narrow behaviour stubs this itself, with the same
 * `stubViewport` this establishes the default through - see that module's own comment for why this
 * call, here, is the one exception to "a test stubs its own width".
 */
stubViewport(true);

if (typeof HTMLDialogElement !== 'undefined') {
  Object.assign(HTMLDialogElement.prototype, {
    showModal(this: HTMLDialogElement) {
      this.open = true;
    },
    close(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
}

/**
 * Not Testing Library's 1000ms default, and it is the tighter of the two
 * deadlines a slow test can hit here - the other is `testTimeout` in
 * vite.config.ts, which says why it is not 5000 either.
 *
 * Every `findBy*` and `waitFor` running on real timers gives up after this
 * long. A page render that takes ~200ms alone was measured taking well over a
 * second when the full suite runs with the machine's cores saturated, and the
 * failure it produces - "Unable to find role ..." with a DOM dump - reads
 * exactly like the element genuinely never appeared. That is the expensive kind
 * of flake: nothing about it says "this was only slow".
 *
 * 5s absorbs that contention, and sits deliberately below `testTimeout` so a
 * query that really will never resolve still fails as Testing Library's
 * diagnostic rather than as a bare Vitest timeout with no DOM to look at.
 *
 * The caveat, for whoever hits it first: this is wall-clock time only while the
 * timers are real. `@testing-library/dom`'s `waitFor` arms its deadline with
 * `setTimeout(..., timeout)` before it checks whether timers are faked, so
 * under a bare `vi.useFakeTimers()` the 5000 becomes 5000 *fake* ms advanced 50
 * at a time - a longer failure path, not a longer grace period. Every
 * fake-timer suite here passes `{ shouldAdvanceTime: true }`, which walks the
 * fake clock at roughly wall-clock pace and keeps the two readings close;
 * timeline-view.test.tsx is the one file that combines fake timers with a
 * `findAllBy*` and it relies on exactly that. A suite that ever freezes the
 * clock outright should pass its own `timeout` to the query rather than lean on
 * this number.
 */
configure({ asyncUtilTimeout: 5_000 });

// user-event's default `delay: 0` parks a macrotask between every keystroke and click. Nothing in
// this suite relies on that yield (a test that does passes its own `delay`), and a long typed
// string or a chain of clicks otherwise pays for each one under a loaded CI runner. The
// pointer-events check walks computed styles up the tree on every action; no stylesheet is loaded
// here, so it never has anything to find.
const setupUser = userEvent.setup.bind(userEvent);
Object.assign(userEvent, {
  setup: (options?: Parameters<typeof setupUser>[0]) =>
    setupUser({ delay: null, pointerEventsCheck: PointerEventsCheckLevel.Never, ...options }),
});

/**
 * Vitest runs with `globals: false`, so describe/it/expect are imported
 * explicitly in every suite. That also means Testing Library cannot register
 * its own automatic cleanup - it looks for a global afterEach - so it is
 * registered here, once, for the whole app.
 */
// The shell asks Core for the caller and the workspace on every mount. Without a stub, every
// suite would be a suite about failed requests; tests that care about a particular answer call
// stubCoreApi again with it.
beforeEach(() => {
  browserStorage()?.clear();
  browserSessionStorage()?.clear();
  // jsdom has no resize notifications; geometry tests replace this observer.
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
  stubCoreApi();
});

afterEach(() => {
  cleanup();

  // The session store is module state and would otherwise leak a signed-in session from one test
  // into the next, which is the sort of order-dependence that only shows up on CI.
  resetSession();

  // The announcer is module state for the same reason the session store is, and leaks the same
  // way: a message left standing would be read by the next test's live region.
  resetAnnouncements();

  vi.unstubAllGlobals();

  // Defense in depth for the suite's default viewport. `stubViewport`'s plain assignment (see its
  // own comment) means `vi.unstubAllGlobals()` above does not restore it the way a
  // `vi.stubGlobal`-based mock would - nothing breaks today only because every narrow-viewport
  // `stubViewport(false)` call happens to sit in the last describe block of its file. Restoring the
  // wide default here is cheap insurance against a test appended after one of those blocks silently
  // inheriting a narrow viewport it never asked for.
  stubViewport(true);
});

// jsdom performs no layout and implements no scrolling, so `Element.scrollIntoView` is simply
// absent. `<Listbox>` calls it to keep the highlighted option in view - the browser will not do it
// for us, because focus deliberately never enters the list - so without this every test that
// renders one throws on the first render rather than failing an assertion.
//
// Shimmed rather than guarded in the component, matching how `Dialog.test.tsx` handles jsdom's
// missing `showModal`: the gap belongs to the environment, and a component that checked for it
// would be carrying a test concern into the product.
// Guarded on `Element` itself as well: not every suite in this project runs in jsdom - the
// stylesheet test runs in node, where there is no DOM at all to patch.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    // Nothing to scroll: jsdom has no viewport.
  };
}

// A contenteditable selection is real DOM state even when layout is not. ProseMirror asks the
// selection's Range for its rectangle only to scroll the caret into view; jsdom omits both Range
// measurement methods entirely. Zero rectangles preserve the state transition without pretending
// that a browser position was measured.
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return [] as unknown as DOMRectList;
  };
}

if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return new DOMRect();
  };
}

// Node 22 supplies fetch/Response while jsdom supplies Blob/File. Keep their binary APIs in
// one realm: Axios probes Blob.stream(), and the API client validates returned Blob instances.
if (typeof FileReader !== 'undefined' && typeof Blob.prototype.stream !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer);
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error('Blob read failed.'));
      };
      reader.readAsArrayBuffer(this);
    });
  };
  Blob.prototype.text = async function text(): Promise<string> {
    return new TextDecoder().decode(await this.arrayBuffer());
  };
  Blob.prototype.stream = function stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    const bytes = this.arrayBuffer();
    return new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(new Uint8Array(await bytes));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  };
  Response.prototype.blob = async function blob(): Promise<Blob> {
    return new Blob([await this.arrayBuffer()], {
      type: this.headers.get('content-type') ?? '',
    });
  };
}
