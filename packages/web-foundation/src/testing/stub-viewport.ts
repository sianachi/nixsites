/**
 * Stubs `matchMedia` to answer a fixed `matches` for every width query - wide or narrow.
 *
 * A plain override, not `vi.stubGlobal`. `setup.ts` needs to establish this once, at module scope,
 * as the suite's persistent default, before any test's `afterEach` ever runs its
 * `vi.unstubAllGlobals()` - a value that teardown had tracked would come undone the moment the
 * first test finished, taking the desktop arrangement away from every test after it. That also
 * means there is no implicit revert here for a test to lean on between one test and the next:
 * whichever width a test wants, it calls this itself, in the test that wants it - the same way
 * `pane-state.test.tsx`'s own `panesAt` always has.
 *
 * A `pointer` or `hover` query is answered separately, and always as a mouse would answer it - fine
 * yes, coarse no, hover yes - regardless of `wide`.
 * This helper is about screen width; a caller asking for a wide viewport is not also claiming a
 * touch input device, and `wide`'s boolean mode previously answered every query alike, so a mouse
 * test that never mentioned pointers at all was silently also a coarse-pointer test. A suite that
 * wants a coarse pointer stubs `matchMedia` itself for that one query, the way
 * `tabs-flows.test.tsx` and `graph-page.test.tsx` do.
 */
export function stubViewport(wide: boolean | number): void {
  if (typeof globalThis.window === 'undefined') {
    return;
  }

  globalThis.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: query.includes('pointer')
        ? query.includes('fine')
        : query.includes('hover')
          ? true
          : typeof wide === 'boolean'
            ? wide
            : wide >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
