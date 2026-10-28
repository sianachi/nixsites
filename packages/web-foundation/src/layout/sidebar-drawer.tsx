import { useEffect, type ReactNode } from 'react';

/**
 * The workspace tree, as an off-canvas drawer.
 *
 * `<WorkspaceSidebar>` is otherwise a permanent flex sibling of the panes it navigates - see
 * `app-shell.tsx`. On a phone there is no room to share: a fixed-width column beside the content
 * would leave neither one usable. This is the same tree, unmounted or mounted by the shell's own
 * narrow-scoped visibility, standing in for the flex panel below the width where a screen can hold
 * both. The caller decides when it is on screen at all - this component only mounts open, the way
 * `SidebarDivider` is unmounted rather than hidden when the tree is (see `app-shell.tsx`'s own
 * comment on that).
 *
 * **Not a native `<dialog>` opened with `showModal()`**, which is what `<Dialog>` in `packages/ui`
 * uses for exactly this problem. That is not a missed reuse: a `showModal()` dialog renders in the
 * browser's own top layer, anchored to the *viewport* rather than to any ancestor in the page - and
 * covering the viewport is exactly what this component exists not to do. The header above it -
 * search, the profile menu, and the very toggle button that opened the drawer - has to stay on
 * screen and reachable, because the toggle is the way back, and a top-layer dialog would sit over
 * it along with everything else.
 *
 * **No focus trap, and no `role="dialog"` either**, for the same reason: this is not a modal in the
 * sense either of those exists to serve. While the drawer is open, `app-shell.tsx` applies React
 * 19's native `inert` attribute to the pane content it overlays - the sibling this component does
 * not itself render - which makes that region genuinely unreachable to pointer and assistive
 * technology without a hand-rolled trap standing in for what the platform already does. The header
 * stays interactive throughout, on purpose: closing the drawer has to remain one tab or one click
 * away. What is left inside is the plain scrim-and-panel below, and the `<aside aria-label
 * ="Workspace">` already inside `<WorkspaceSidebar>` is the real landmark here once nothing wraps
 * it in a dialog role it was never using anyway.
 */

export interface SidebarDrawerProps {
  /** Asked to close - by Escape or by tapping the scrim. Whether that closes anything, and where
   * focus goes afterwards, is entirely the caller's decision - see `app-shell.tsx`, which sends
   * focus to the header's own toggle button on this path and somewhere else entirely when a row is
   * picked instead. */
  readonly onClose: () => void;

  readonly children: ReactNode;
}

export function SidebarDrawer({ onClose, children }: SidebarDrawerProps): ReactNode {
  useEffect(() => {
    // On `window`, not `document`. `document` sits between a keydown's target and `window` on
    // every event's path, so anything nested inside this drawer that needs "my own Escape wins"
    // stops propagation at `document` - see `CreateMenu` (`workspace-sidebar.tsx`), `ProfileMenu`
    // and `CommandPalette` for that half of the convention - and never reaches a listener out here
    // at all. That ordering is fixed by where each listener sits in the DOM's own propagation
    // path, not by which of them happened to attach first: two listeners on the very same node run
    // in attachment order regardless of `stopPropagation`, which is why the drawer listens further
    // out instead of trying to out-order every interactive layer that might nest inside it.
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      {/* Dismisses on tap, the gesture everybody tries first. Not reachable by Tab - Escape is
          the keyboard way out, and a scrim in the tab sequence would be a stop between the panel
          and itself with nothing to say about either. Sized to the whole remaining area, so as a
          touch target it clears WCAG 2.5.8's 24px minimum by a wide margin. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close the Explorer"
        onClick={onClose}
        className="absolute inset-0 z-0 cursor-pointer bg-neutral-900/40"
      />

      {/* design-token-exempt: the phone browser takes the available width; wider drawers cap at
          320px with room for a dismissing scrim. This is panel geometry, not a spacing scale.

          `z-10`, not `z-20`: this panel and the scrim below it sit *beside* `<main>`, not inside
          it, so `<main>`'s own `isolate` (see `app-shell.tsx`) does nothing to keep this pair out
          of the header's way - stacking containment only reaches descendants, and these two are
          `<main>`'s siblings. What actually keeps them from competing with the header's popovers
          is the number itself: low enough to lose outright to the profile menu and search overlay
          in the one stacking context they all share. Ordering the panel above its own scrim
          (`z-10` over `z-0`) is the only thing this pair's numbers need to do relative to each
          other. See `app-shell.tsx`'s skip-link comment for the full ladder. */}
      <div className="absolute inset-y-0 left-0 z-10 flex w-full shrink-0 overflow-hidden shadow-lg sm:w-[min(85%,320px)]">
        {children}
      </div>
    </>
  );
}
