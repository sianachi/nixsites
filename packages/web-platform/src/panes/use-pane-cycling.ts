import { useEffect } from 'react';

import { paneElementId } from './pane-params';

/**
 * F6 moves focus between the open pane regions; Shift F6 moves it backwards.
 *
 * The key browsers and screen readers already use for "next region": inside a pane, Tab walks the
 * controls, and without this the only way from a control deep in pane one to pane two is tabbing
 * through everything in between - a whole editor, on a bad day. The pane regions are the app's own
 * regions, so the app's F6 cycles them.
 *
 * **Cycles, rather than stopping at the ends**, per the ARIA practices' reading of F6 among
 * regions: the wrap is what makes one key enough, instead of needing a second key to come back.
 *
 * **Only claimed when there are panes to cycle.** With one pane F6 has nowhere to go, and a key
 * that is swallowed while visibly doing nothing reads as broken - so it is left to the browser,
 * which may have its own use for it.
 *
 * **Nothing is announced, deliberately.** The move speaks for itself: the pane region carries
 * `aria-label="Pane n of m: title"` (`editor-page.tsx`), which is set under exactly the condition
 * this hook is registered under - more than one pane - and is read the moment focus lands on it.
 * A live-region line saying "Pane 2 of 3." would be a strictly less informative subset of what the
 * focus move already says, arriving at the same instant: on NVDA and JAWS that is a stutter or an
 * interruption, not a second chance to hear it. If a message is ever wanted here it has to carry
 * something the label does not - the wrap, for instance - rather than repeat it.
 */
export function usePaneCycling(paneCount: number): void {
  useEffect(() => {
    if (paneCount < 2) {
      return;
    }

    function onKeyDown(event: KeyboardEvent): void {
      // Shift is the one modifier with a meaning here; the rest stay the browser's.
      if (event.key !== 'F6' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      // A held key repeats at the platform's autorepeat rate, which would spin through the panes
      // as fast as the keyboard reports. F6 is a step, not a scrub.
      if (event.repeat) {
        return;
      }

      const regions: HTMLElement[] = [];
      for (let index = 0; index < paneCount; index += 1) {
        const element = document.getElementById(paneElementId(index));
        if (element === null) {
          // The arrangement is mid-render, or another screen is open. Not claimed.
          return;
        }
        regions.push(element);
      }

      const active = document.activeElement;
      const position = regions.findIndex((region) => active !== null && region.contains(active));

      // From outside every pane - the tree, the header - F6 enters at the first pane, and
      // Shift F6 at the last, which is where each direction of travel would arrive anyway.
      const next =
        position === -1
          ? event.shiftKey
            ? paneCount - 1
            : 0
          : (position + (event.shiftKey ? -1 : 1) + paneCount) % paneCount;

      // Focus first, and claim the key only once focus has actually arrived.
      //
      // The key is swallowed on the strength of an *outcome*, never an intention. A modal
      // `<Dialog>` puts the rest of the document behind `showModal`, and `.focus()` on an element
      // inside an inert subtree is a silent no-op - so preventing the default there would take F6
      // away from the dialog while moving nothing. Asking whether the region ended up holding
      // focus covers inert, detached and modal at once, rather than special-casing any of them.
      //
      // `contains` rather than an identity check, because it is the region that was asked to take
      // focus but a delegating descendant may be what ends up with it.
      const target = regions[next];
      if (target === undefined) {
        return;
      }

      target.focus();
      if (!target.contains(document.activeElement)) {
        return;
      }

      event.preventDefault();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [paneCount]);
}
