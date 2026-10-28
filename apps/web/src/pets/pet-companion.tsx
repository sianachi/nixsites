import { type PetProfile, type PetSettings } from '@nix/api-client';
import { Button } from '@nix/ui';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from '../workspaces/workspace-context';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useMobileKeyboard } from '@nix/web-foundation/layout/use-mobile-keyboard';
import { useBackDismiss } from '@nix/web-foundation/layout/use-back-dismiss';
import { openPanelPosition } from './panel-position';
import { PetAvatar } from './pet-avatar';
import { publishPetAttention } from './pet-attention';
import { useOpenChat } from '../tabs/use-open-chat';
import { usePanes } from '@nix/web-platform/panes/pane-state';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import { usePetRuntime } from './use-pet-runtime';
import {
  readDevicePreference,
  readPetPosition,
  writePetPosition,
} from '@nix/web-foundation/lib/device-preferences';
import { chatOpensAsPage, launcherFloats, pageIsAvailable } from './pet-surface';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePetSurface } from './use-pet-surface';
import { PetWorkTools } from './work-tools/pet-work-tools';
import { Conversation } from './conversation/conversation';

/** The shell and note dock publish their bottom clearance so every launcher position stays
 * above whichever control reaches further into the viewport. */
function mobileBottomClearance(): number {
  return Math.max(
    ...['--mobile-nav-height', '--mobile-note-toolbar-clearance'].map((property) => {
      const parsed = Number.parseFloat(document.documentElement.style.getPropertyValue(property));
      return Number.isFinite(parsed) ? parsed : 0;
    }),
  );
}

/** Where the pet page lives, for the launcher and the panel's "Open as page" to link to. */
export function petPageHref(workspaceId: string): string {
  return `/w/${workspaceId}/pet`;
}

export function PetCompanion(): ReactElement | null {
  const { workspaceId } = useWorkspace();
  const { saved } = usePetSettings();
  const { pathname } = useLocation();
  const zen = useZenActive();
  const { panes } = usePanes();
  const pet = saved?.settings.profiles.find((profile) => profile.id === saved.settings.activePetId);
  if (!saved?.settings.enabled || !pet) return null;
  // Zen is the item alone in the window: the launcher is part of the chrome it takes away, so it
  // renders nothing, as on the pet page, rather than hiding it, so no control of it stays in the
  // tab order. Its open panel does not survive the round trip; the price of being truly absent.
  // The pet page runs its own runtime and tools; rendering nothing here, rather than hiding the
  // launcher, is what keeps a second `usePetRuntime` and `PetWorkTools` from ever existing beside
  // it. Matched the way the navigation rail matches its destinations, on the workspace-rooted
  // path.
  const petPagePath = petPageHref(workspaceId);
  if (zen || pathname === petPagePath || pathname.startsWith(`${petPagePath}/`)) return null;
  // A workspace conversation open as a tab runs its own runtime; this panel would be a second one.
  if (panes.some((pane) => pane.chat === 'workspace')) return null;
  return (
    <Companion
      key={`${workspaceId}:${pet.id}:${pet.provider}`}
      workspaceId={workspaceId}
      pet={pet}
      settings={saved.settings}
    />
  );
}

function Companion({
  workspaceId,
  pet,
  settings,
}: {
  readonly workspaceId: string;
  readonly pet: PetProfile;
  readonly settings: PetSettings;
}) {
  // `?pet=design` (the template library's "Design one with your pet") opens the conversation.
  const [search] = useSearchParams();
  const designEntry = search.get('pet') === 'design';
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const client = useApiClient();
  const runtimeApi = usePetRuntime(workspaceId, pet.id, open);
  // The ids of the pending tools `PetWorkTools` itself reports as actually waiting on the owner
  // - never any `pending` tool, which would also badge an auto-run read - see must-fix 1. Only
  // one `PetWorkTools` instance is ever mounted at a time (the hidden one below while the panel
  // is closed, the one inside `Conversation` while it is open, or the one on the pet page, where
  // `PetCompanion` renders nothing at all), so a single lifted setter here is always hearing from
  // whichever one is currently live.
  const [needsDecisionIds, setNeedsDecisionIds] = useState<readonly string[]>([]);
  const toolPending = needsDecisionIds.length > 0;
  const [unseenReply, setUnseenReply] = useState(false);
  const previousState = useRef(runtimeApi.runtime?.state);
  // A reply that finishes while the panel is closed sets the launcher badge; opening the panel
  // clears it. The `queueMicrotask` wrapper (the same one `designEntry` below uses) is what
  // keeps this a subscription-style callback reacting to the runtime's own change, rather than
  // a derived value computed synchronously in the effect body. Must-fix 2: only a real
  // thinking -> success transition badges the launcher - the very first state this hook ever
  // observes (an already-finished conversation loading for the first time) is a baseline, not a
  // reply that "just" finished, so it must never itself set the badge.
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const state = runtimeApi.runtime?.state;
      if (open) setUnseenReply(false);
      else if (state === 'success' && previousState.current === 'thinking') setUnseenReply(true);
      previousState.current = state;
    });
    return () => {
      active = false;
    };
  }, [open, runtimeApi.runtime?.state]);
  const [hover, setHover] = useState(false);
  const launcher = useRef<HTMLButtonElement | null>(null);
  const aside = useRef<HTMLElement | null>(null);
  // The launcher is hidden once the panel is open, so it cannot be measured then; its rect from
  // the moment of opening is what the panel's position is worked out from.
  const openedFrom = useRef<DOMRect | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const [placement, setPlacement] = useState(() => readDevicePreference('placement'));
  const [position, setPosition] = useState(() => readPetPosition());
  const drag = useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const returnFocus = useRef(false);
  const narrow = useNarrowViewport();
  const surface = usePetSurface();
  const opensAsPage = chatOpensAsPage(surface, narrow);
  // A tab in the open pane where tabs are drawn, the companion page elsewhere.
  const openChat = useOpenChat();
  const openPage = () => {
    openChat(null);
  };
  useBackDismiss(open && narrow, () => {
    setOpen(false);
    returnFocus.current = true;
  });
  const keyboardVisible = useMobileKeyboard(narrow);
  // Where the chat opens as a page (always, or on a phone) there is no floating pet. The component
  // stays mounted, so a turn still gets its auto-run reads while the owner is elsewhere in the
  // workspace, but it draws nothing; a panel already open when the preference changes stays until
  // it is closed.
  const floats = launcherFloats(surface, narrow) || open;
  const launcherHidden = open || !floats || (narrow && keyboardVisible);
  useEffect(() => {
    if (!designEntry) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (opensAsPage) void navigate(petPageHref(workspaceId), { replace: true });
      else setOpen(true);
    });
    return () => {
      active = false;
    };
  }, [designEntry, opensAsPage, navigate, workspaceId]);
  // Close (or the back gesture) may fire while the keyboard still occludes the page, which
  // keeps the launcher `hidden`; a hidden button cannot take focus, so waiting for
  // `launcherHidden` to clear - rather than focusing right on close - is what makes focus land
  // on it once it is actually visible again, on a phone or a desktop alike.
  useEffect(() => {
    // With no floating launcher there is nothing to hand focus back to, and a flag left set
    // would pull focus to the launcher out of nowhere if floating were chosen again later.
    if (!floats) returnFocus.current = false;
    else if (returnFocus.current && !launcherHidden) {
      returnFocus.current = false;
      launcher.current?.focus();
    }
  }, [launcherHidden, floats]);
  // The launcher's dot and its "(needs approval)" are the only notice of a turn waiting on the
  // owner. Without a launcher the same fact goes to the navigation entry (`pet-attention.ts`), so
  // a waiting approval is never silent. Cleared on unmount, which includes arriving on the pet
  // page, where the conversation itself shows it.
  const attention = floats ? null : toolPending ? 'approval' : unseenReply ? 'reply' : null;
  useEffect(() => {
    publishPetAttention(attention);
    return () => {
      publishPetAttention(null);
    };
  }, [attention]);
  useEffect(() => {
    const changed = () => {
      setPlacement(readDevicePreference('placement'));
      setPosition(readPetPosition());
    };
    window.addEventListener('nix-pet-device-changed', changed);
    return () => {
      window.removeEventListener('nix-pet-device-changed', changed);
    };
  }, []);
  // A saved position can sit off-screen, or over the bottom navigation, at a width or clearance
  // different from the one it was saved at - a desktop position visited on a phone, a phone
  // rotated to landscape crossing back past the phone breakpoint, a tablet, or a placement
  // changed from the settings page in this same tab. This keeps what is *rendered* inside the
  // viewport and clear of the nav on load, resize, orientation change, a placement change, and a
  // change in the nav's own measured height (a PWA banner appearing above it); it never writes
  // back, so the saved position itself is untouched and a width that fits it again renders it
  // exactly as saved. Only a user drag (`onPointerMove` below) calls `writePetPosition`.
  useEffect(() => {
    const recompute = () => {
      const saved = readPetPosition();
      if (!saved) return;
      const rect = launcher.current?.getBoundingClientRect();
      // A `hidden` launcher (the keyboard is up) measures 0x0; clamping to that would pin the
      // button flush with the far edge instead of leaving it where it actually is. Skipping
      // then is safe: `keyboardVisible` is also a dependency below, so this re-runs, with a real
      // rect, the moment the launcher is visible again.
      if (!rect || rect.width === 0 || rect.height === 0) return;
      const next = {
        x: Math.min(Math.max(8, saved.x), Math.max(8, window.innerWidth - rect.width - 8)),
        y: Math.min(
          Math.max(8, saved.y),
          Math.max(8, window.innerHeight - rect.height - 8 - mobileBottomClearance()),
        ),
      };
      setPosition((current) => {
        const unchanged = current !== null && current.x === next.x && current.y === next.y;
        return unchanged ? current : next;
      });
    };
    recompute();
    window.addEventListener('resize', recompute);
    window.addEventListener('orientationchange', recompute);
    // A placement change from the settings page (the effect above, listening for the same event)
    // sets the raw saved value first; registered after it, this listener always runs second for
    // the same dispatch and reclamps whatever it just set.
    window.addEventListener('nix-pet-device-changed', recompute);
    // The shell's own measurement of the nav's height (`app-shell.tsx`) can change without the
    // window resizing at all - a PWA install or update banner appearing above the nav grows it -
    // so the shell announces every change to it rather than leaving this to notice only on the
    // next resize.
    window.addEventListener('nix-mobile-nav-resized', recompute);
    window.addEventListener('nix-mobile-note-toolbar-resized', recompute);
    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('orientationchange', recompute);
      window.removeEventListener('nix-pet-device-changed', recompute);
      window.removeEventListener('nix-mobile-nav-resized', recompute);
      window.removeEventListener('nix-mobile-note-toolbar-resized', recompute);
    };
  }, [keyboardVisible]);
  // The launcher is clamped to the viewport at its own small size, so the panel, which is far
  // larger, would run off the right or bottom edge when it opens from a dragged position. While
  // open, the panel keeps its corner nearest the launcher where the launcher was and is then
  // pulled back inside the viewport. It is measured rather than assumed because the panel's size
  // depends on the viewport (`h-[calc(100dvh-...)]`), and re-measured on a window resize or when
  // the aside's own size changes. A narrow viewport shows the panel as a full-screen dialog and is
  // left alone.
  const dragged = position !== null;
  useLayoutEffect(() => {
    const element = aside.current;
    const from = openedFrom.current;
    if (!open || !dragged || narrow || !element || !from) return;
    const place = () => {
      const size = element.getBoundingClientRect();
      const next = openPanelPosition(
        from,
        { width: size.width, height: size.height },
        { width: window.innerWidth, height: window.innerHeight },
        8,
        mobileBottomClearance(),
      );
      setPanelPosition((current) =>
        current !== null && current.left === next.left && current.top === next.top ? current : next,
      );
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [open, dragged, narrow]);
  // No token names the mobile navigation's rendered height (mobile-navigation.tsx has no fixed
  // height of its own, and includes the PWA banner above it when shown); 3.5rem plus the safe-area
  // inset is the fallback so a phone launcher never sits under it before the shell has measured
  // one, or once the nav is not rendered at all. The measured value already includes the inset
  // (`mobile-navigation.tsx` pads itself with it), so only the fallback adds it. Cleared at `lg:`
  // (1024px, `WIDE_ENOUGH_FOR_A_FIXED_SIDEBAR` in `layout/regions.ts`) rather than `sm:`: the
  // bottom navigation this offset clears renders across the whole drawer-nav range
  // (`useDrawerNavigation`, below 1024px), a tablet included, not only below the phone breakpoint
  // (`useNarrowViewport`, 640px) that `narrow` itself tracks.
  const narrowOffset =
    'bottom-[max(var(--mobile-nav-height,calc(3.5rem+env(safe-area-inset-bottom))),var(--mobile-note-toolbar-clearance,0%))]'; // design-token-exempt: navigation and writing toolbar clearance are measured at runtime.
  return (
    <aside
      ref={aside}
      aria-label={`${pet.name} companion`}
      className={`fixed z-40 max-w-full flex-col gap-2 p-2 ${floats ? 'flex' : 'hidden'} ${position ? '' : `${narrowOffset} lg:bottom-4 ${placement === 'left' ? 'left-0 items-start sm:left-4' : 'right-0 items-end sm:right-4'}`}`}
      style={
        position
          ? open && panelPosition && !narrow
            ? panelPosition
            : { left: position.x, top: position.y }
          : undefined
      }
    >
      {open ? (
        <Conversation
          key={`${workspaceId}:${pet.id}`}
          workspaceId={workspaceId}
          pet={pet}
          settings={settings}
          layout={narrow ? 'fullscreen' : 'floating'}
          runtimeApi={runtimeApi}
          onNeedsDecisionChange={setNeedsDecisionIds}
          {...(pageIsAvailable(surface, narrow) ? { onOpenAsPage: openPage } : {})}
          onClose={() => {
            setOpen(false);
            returnFocus.current = true;
          }}
        />
      ) : runtimeApi.runtime ? (
        // Auto-run reads (READ_ONLY_OPERATIONS under readWithoutAsking)
        // must still run while the panel is closed, so a closed panel never stalls a turn on a
        // read - see `ReadActivityRow`'s own auto-run effect. `hidden` keeps this out of both
        // the visual layout and the accessibility tree while the panel is closed.
        <div className="hidden">
          <PetWorkTools
            client={client}
            runtime={runtimeApi.runtime}
            workspaceId={workspaceId}
            petId={pet.id}
            petName={pet.name}
            onChange={runtimeApi.setRuntime}
            onNeedsDecisionChange={setNeedsDecisionIds}
          />
        </div>
      ) : null}
      <Button
        ref={launcher}
        variant="ghost"
        // No card and no wash behind the pet: it stands on the page; its hover pose is the feedback.
        className={`relative h-auto touch-none p-1 hover:bg-transparent active:bg-transparent ${launcherHidden ? 'hidden' : ''}`}
        aria-expanded={opensAsPage ? undefined : open}
        aria-label={`${open ? `Close ${pet.name}` : opensAsPage ? `Open ${pet.name}` : `Talk with ${pet.name}`}${
          !open && toolPending ? ' (needs approval)' : !open && unseenReply ? ' (new reply)' : ''
        }`}
        onMouseEnter={() => {
          setHover(true);
        }}
        onMouseLeave={() => {
          setHover(false);
        }}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (opensAsPage && !open) {
            openPage();
            return;
          }
          const nextOpen = !open;
          openedFrom.current = nextOpen ? event.currentTarget.getBoundingClientRect() : null;
          if (!nextOpen) setPanelPosition(null);
          setOpen(nextOpen);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          // A drag that ends past the tap slop, on touch, dispatches no `click` at all: the flag
          // `onClick` would otherwise clear stays set, and the very next real tap is swallowed
          // silently. Starting every new pointer-down clean is what keeps a stale flag from a
          // prior drag from ever eating a later tap.
          suppressClick.current = false;
          const rect = event.currentTarget.getBoundingClientRect();
          drag.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            startX: event.clientX,
            startY: event.clientY,
            moved: false,
          };
          if (typeof event.currentTarget.setPointerCapture === 'function')
            event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active?.pointerId !== event.pointerId) return;
          // Cumulative distance from where the pointer went down, rather than the per-event
          // `movementX`/`movementY` delta: some engines never populate a non-zero delta for a
          // touch pointer, which would otherwise make a drag never register as one at all.
          const moved =
            active.moved ||
            Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 2;
          active.moved = moved;
          if (!moved) return;
          suppressClick.current = true;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.min(
            Math.max(8, event.clientX - active.offsetX),
            window.innerWidth - rect.width - 8,
          );
          const y = Math.min(
            Math.max(8, event.clientY - active.offsetY),
            Math.max(8, window.innerHeight - rect.height - 8 - mobileBottomClearance()),
          );
          const next = { x, y };
          setPosition(next);
          writePetPosition(next);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        title="Drag to move companion"
      >
        <span className="flex items-center justify-center p-1">
          <PetAvatar
            appearance={pet.appearance}
            state={hover ? 'hover' : 'idle'}
            motion={settings.motion}
            label={pet.name}
            size={narrow ? 'compact' : 'regular'}
          />
        </span>
        {!open && (toolPending || unseenReply) ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2.5 rounded-full bg-accent-fill ring-2 ring-background"
          />
        ) : null}
      </Button>
    </aside>
  );
}
