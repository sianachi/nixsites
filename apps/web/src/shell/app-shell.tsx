import { MobileNoteCapture } from '../items/mobile-note-capture';
import { useMobileKeyboard, useVisualViewportHeight } from '../layout/use-mobile-keyboard';
import { useBackDismiss } from '../layout/use-back-dismiss';
import { describeBulkDelete, executeBulkDelete } from '../items/bulk-delete';
import { ItemCommandsProvider } from '../items/item-commands-context';
import { ItemDialogProvider } from '../items/item-dialog-provider';
import { MobileNavigation } from './mobile-navigation';
import { petAttentionText } from '../pets/pet-attention';
import { usePetNavEntry } from '../pets/use-pet-nav-entry';
import { PwaControls } from '../pwa/pwa-controls';
import { useRememberLocation } from '../pwa/use-remember-location';
import { focusRing } from '@nix/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Outlet, useLocation, useNavigate } from 'react-router';

import { useAuth } from '../auth/auth-provider';
import { ImportDialog } from '../import/import-dialog';
import { consumeInterruptedImportForWorkspace } from '../import/import-interrupted-notice';
import { useWorkspaceTree, type TreeItem } from '../items/use-workspace-tree';
import { announce, useAnnouncement } from '../a11y/announcer';
import type { ShellContext } from './shell-context';
import { focusPane } from '../panes/pane-params';
import { usePanes } from '../panes/pane-state';
import { useSelectedItem } from '../routing/selected-item';
import { automationsHref } from '../automations/automation-url';
import { CommandPalette } from '../search/command-palette';
import { builtInCommands } from '../search/commands';
import { useBookmarksLoader, useBookmarksStore, useIsKept } from '../bookmarks/use-bookmarks';
import { MiniPlayer } from '../audio/mini-player';
import { useOpenItem } from '../tabs/use-open-item';
import { useOpenDailyOnLaunch } from '../launch/use-open-daily-on-launch';
import { useUiSettingsSync } from '../settings/shared/use-ui-settings-sync';
import { DailyCaptureDialog } from '../daily-notes/daily-capture-dialog';
import { useSessionStore } from '../auth/session-store';
import { CapabilitiesProvider } from '../session/capabilities-context';
import { useCurrentPrincipal } from '../session/use-current-principal';
import { paneClip } from '../layout/regions';
import { NavRail } from './nav-rail';
import { useDrawerNavigation } from '../layout/viewport';
import { useSidebar } from '../layout/use-sidebar';
import type { StructuredRecipeId } from '../views/wizard/structured-recipes';
import { useTemplates } from '../templates/use-templates';
import { TemplateLibraryProvider } from '../templates/template-library-context';
import { ShellHeader } from './shell-header';
import { KeyboardShortcutsDialog } from '../keyboard/keyboard-shortcuts-dialog';
import { useRevealOpenPanes, useShellShortcuts, useZenEscape } from './shell-effects';
import { ZenExit } from './zen-exit';
import { NotificationInboxPanel } from './notifications/notification-inbox-panel';
import { useNotificationsInbox } from './notifications/use-notifications-inbox';
import { ShellSidebar } from './shell-sidebar';
import { ShellToasts, useShellToasts } from './shell-toasts';
import { useWorkspace } from '../workspaces/workspace-context';
import { WorkspaceInvitationNotice } from '../workspaces/workspace-invitation-notice';
import type { LaunchNavigationState } from '../launch/launch-intent';
import { viewCommitted } from '../lib/view-transition';
import { onNotice } from '../lib/notices';
import { recordRecentItem } from '../lib/recent-items';
import {
  claimZenSurface,
  onZenModeChanged,
  setZenMode,
  toggleZenMode,
  useZenActive,
} from '../lib/zen-mode';

/**
 * The application chrome: one workspace, always visible.
 *
 * **There is no tab strip, and that is the point.** Tabs were a faithful reading of the design
 * file's five example screens and the wrong shape for the product: they made a board and a search
 * page into destinations, which they are not. A board is a way of looking at a container, and
 * searching is something you do while reading rather than instead of it. So the shell is a
 * persistent tree beside whatever is open, a search affordance that opens over the top, and a
 * profile menu holding what belongs to the person rather than to the document.
 *
 * The tree lives here rather than on the editor screen because it is how you move around; a tree
 * that appeared on one screen would make every other screen a dead end.
 *
 * ## The shell owns the viewport
 *
 * Exactly one element is `h-dvh`, exactly one element clips, and each pane owns exactly one
 * scroller. **Vertical belongs to the pane. Horizontal belongs to the view**, because only the view
 * knows what its wide axis is - a board scrolls through columns, a table through property columns,
 * and the pane cannot know which.
 *
 * That division is a convention the views keep, not something the CSS enforces. A pane's
 * `overflow-y-auto` makes it a scroll container on *both* axes - per CSS Overflow 3, one axis
 * leaving `visible` takes the other with it - so what actually keeps the horizontal axis quiet is
 * that every wide view brings its own `overflow-x-auto` and `min-w-0` lets the pane shrink to fit
 * around it. See `paneScroller` in `../layout/regions`.
 *
 * This was previously unimplemented rather than mis-tuned, and it failed in two directions at once.
 * The root was `min-h-dvh`, so `flex-1` never had a definite height and no descendant's
 * `overflow-auto` ever had anything to scroll - every pane grew instead, and the page scrolled.
 * And nothing anywhere clipped: `min-w-0` lets a box shrink but does not stop a descendant painting
 * outside it, so a wide table pushed the *document* into horizontal scroll. Scrolling right then
 * slid the whole page, carrying the fixed sidebar off-screen while view content took the pixels it
 * had been holding - which read as content overflowing into the tree.
 *
 * **No view owns its own vertical axis today, and the one that looks like it does, does not.** The
 * calendar's hour grid carries an `overflow-y-auto` (`calendar-hours.tsx`), but the `Blueprint`
 * above it has no definite height, so the grid's 24 rows size that element instead of scrolling
 * inside it and the pane ends up carrying the whole thing. There are not two vertical scrollers
 * competing - there is one, and it is the pane's. Nothing is unreachable, so this is left alone
 * rather than restructured from the shell; a view that genuinely wants its own vertical axis would
 * need a definite height first, and that is a decision for the view.
 */

export function AppShell(): ReactNode {
  const navigate = useNavigate();
  const { workspaceId, workspace, reload: reloadWorkspaces } = useWorkspace();
  useRememberLocation(workspaceId);
  useOpenDailyOnLaunch();
  const [dailyCaptureOpen, setDailyCaptureOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const { getAccessToken } = useAuth();
  const tree = useWorkspaceTree();
  const principal = useCurrentPrincipal();
  const capabilities = useMemo(
    () =>
      principal.principal === null
        ? null
        : {
            ...principal.principal.features,
            tenantAdministrator: principal.principal.isTenantAdministrator,
          },
    [principal.principal],
  );
  useUiSettingsSync(principal.principal?.id);
  const { selectedId } = useSelectedItem();
  // Homebase lists what was opened last. Recorded once the tree knows the item, so a chat tab or a
  // link to something unreadable is never listed, and a rename is picked up.
  const selectedTitle = selectedId === null ? undefined : tree.find(selectedId)?.title;
  useEffect(() => {
    if (selectedId !== null && selectedTitle !== undefined)
      recordRecentItem(workspaceId, selectedId, selectedTitle);
  }, [workspaceId, selectedId, selectedTitle]);
  const { panes } = usePanes();
  const { openPreview, openPinned, openBeside, canOpenBeside, besideRefusal } = useOpenItem();
  const announcement = useAnnouncement();
  const narrow = useDrawerNavigation();
  const keyboardVisible = useMobileKeyboard(narrow);
  const templateLibrary = useTemplates();
  // One claim covers every workspace route, including pages without an open item.
  useLayoutEffect(claimZenSurface, []);
  const zen = useZenActive();
  const mainRef = useRef<HTMLElement>(null);
  const previousZen = useRef(zen);
  useEffect(() => {
    if (previousZen.current === zen) return;
    previousZen.current = zen;
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body || document.activeElement === null) {
        mainRef.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [zen]);

  // The shelf is loaded once, here, because four places read it at the same time - this page's
  // rail, the tree's rows, the open document's control and the palette. See use-bookmarks.ts.
  useBookmarksLoader();
  const toggleBookmark = useBookmarksStore((state) => state.toggle);
  const selectedIsKept = useIsKept(selectedId);
  const sidebar = useSidebar(narrow);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();
  // The companion page owns a phone screen: chrome would otherwise squeeze the message list to a
  // sliver.
  const chatOwnsScreen = narrow && /^\/w\/[^/]+\/pet\/?$/.test(location.pathname);
  const visibleHeight = useVisualViewportHeight(chatOwnsScreen && keyboardVisible);
  // The installed app's Search shortcut lands here with a request to open search over whatever
  // is showing. Taken during render, once per history entry (React's pattern for state that
  // follows a changed input), then cleared from history so Back and a reload do not reopen it.
  // Ends a crossfade waiting on this navigation: the new location is in the DOM now, before
  // paint, which is the moment `withViewTransition` needs for its second snapshot.
  useLayoutEffect(() => {
    viewCommitted();
  }, [location.key]);
  const launchState = location.state as LaunchNavigationState | null;
  const [launchConsumed, setLaunchConsumed] = useState<string | null>(null);
  if (launchState?.openSearch === true && launchConsumed !== location.key) {
    setLaunchConsumed(location.key);
    setSearchOpen(true);
  }
  useEffect(() => {
    if (launchState?.openSearch !== true) return;
    void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [launchState, location.pathname, location.search, navigate]);
  const [workspaceImportOpen, setWorkspaceImportOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const notificationsInbox = useNotificationsInbox();
  const petEntry = usePetNavEntry();
  useBackDismiss(
    narrow && (sidebar.visible || searchOpen || workspaceImportOpen || inboxOpen),
    () => {
      setWorkspaceImportOpen(false);
      setSearchOpen(false);
      setInboxOpen(false);
      if (sidebar.visible) sidebar.toggle();
    },
  );

  // What Escape and a scrim tap - the two "never mind" exits from the drawer - focus afterwards.
  // Unlike `closeDrawerAfter` above, these are not "there, that one": nothing was chosen, so focus
  // belongs on the control that reopens the drawer, the same place it already was before the
  // drawer took it.
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  function openFlow(path: string, parentId: string | null): void {
    const search = parentId === null ? '' : `?parent=${encodeURIComponent(parentId)}`;
    void navigate(`/w/${workspaceId}/${path}${search}`);
    if (narrow && sidebar.visible) sidebar.toggle();
  }

  const startStructured = (parentId: string | null, recipe: StructuredRecipeId): void => {
    openFlow(`new/${recipe}`, parentId);
  };
  const startTemplate = (parentId: string | null, templateId: string): void => {
    openFlow(`templates/${templateId}/create`, parentId);
  };
  const browseTemplates = (parentId: string | null): void => {
    openFlow('templates', parentId);
  };

  // Where focus goes once a delete toast's undo window closes, by any path. The row that opened it
  // is gone by then - deleted, which is why there is a toast at all - so there is no invoker to
  // return focus to the way `<Dialog>` does; the tree's own scroll region, inside
  // `<WorkspaceSidebar>`, is the nearest thing that is still guaranteed to be there. Owned here
  // rather than by the sidebar because the toast that reads it is rendered here too - see the
  // toast state below for why.
  const treeRegionRef = useRef<HTMLDivElement>(null);

  const shellToasts = useShellToasts();
  // Passing notices from anywhere in the workspace - a copied link, closed tabs - shown once,
  // here, as a toast for sighted readers and through the live region for everyone else.
  const pushToast = shellToasts.push;
  useEffect(
    () =>
      onNotice((notice) => {
        announce(notice.message);
        pushToast(notice);
      }),
    [pushToast],
  );

  // A notification that arrives while the app is open and focused surfaces immediately as a
  // shell toast, with an Open action to the item it names - the inbox panel itself only needs to
  // be opened when the person goes looking, not for every arrival while they are already here.
  useEffect(
    () =>
      notificationsInbox.onArrived((arrived) => {
        for (const notification of arrived) {
          const itemId = notification.itemId;
          shellToasts.push({
            key: `notification-${notification.id}`,
            message: notification.title,
            autoFocus: false,
            persistent: true,
            ...(itemId === null
              ? {}
              : {
                  action: {
                    label: 'Open',
                    onAction: () => {
                      openPreview(itemId);
                    },
                  },
                }),
          });
        }
      }),
    // shellToasts.push is stable across renders (see use-shell-toasts's own state setter), and
    // openPreview is a useCallback from useOpenItem - only the inbox's own subscription needs to
    // move when the client that backs it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notificationsInbox],
  );

  // A screen that got torn down mid-import - a session expiring underneath it, chief among the
  // ways that happens - left a short, content-free summary behind for this workspace (see
  // `import-interrupted-notice.ts`). This is where it finally gets read: once, on arrival in the
  // workspace it names, as an ordinary shell toast rather than a special screen of its own.
  const subject = useSessionStore((state) => state.profile?.subject ?? null);
  useEffect(() => {
    if (subject === null) {
      return;
    }
    const message = consumeInterruptedImportForWorkspace(workspaceId, subject);
    if (message !== null) {
      shellToasts.push({ key: 'import-interrupted', message, autoFocus: false });
    }
    // Only the workspace and the person identify which pending notice, if any, belongs here; re-running this
    // whenever the toast queue itself changes would re-read storage that consuming it already
    // cleared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, subject]);

  /**
   * Deletes at once and reports it, rather than asking first: the interface used to gate this
   * behind `globalThis.confirm()`, on the reasoning that deletion read as permanent with no way
   * back. `tree.restore` already existed and had no caller - the honest fix was to give deletion
   * an undo instead of a better-looking confirmation, which is what the toast below is for.
   *
   * **Awaits `tree.remove` before claiming anything happened.** A toast that appeared the instant
   * the request was sent, rather than once it actually succeeded, would assert a past-tense fact
   * ("Deleted") before it was one - and on a failure would go on asserting it while the item sat
   * unchanged in the tree, its real error rendered at the sidebar's foot, underneath the toast that
   * was lying about it. No toast at all is the honest response to a refusal; the foot-of-sidebar
   * alert (`tree.error`, set by `tree.remove` itself) is what explains it.
   *
   * Lives here rather than on `<WorkspaceSidebar>` because the toast this shows is a shell-level
   * overlay, not a sidebar-scoped one - see `shell-toasts.tsx` for why that move mattered.
   */
  async function requestDelete(
    item: Pick<TreeItem, 'id' | 'title' | 'hasChildren'>,
  ): Promise<void> {
    const title = item.title || 'Untitled';
    const { refusal } = await tree.remove(item.id);
    if (refusal !== null) {
      return;
    }

    shellToasts.push({
      key: item.id,
      message: item.hasChildren
        ? `Deleted "${title}" and everything inside it.`
        : `Deleted "${title}".`,
      action: {
        label: 'Undo',
        onAction: () => {
          void undoDeletion(item.id, title);
        },
      },
    });
  }

  /**
   * The bulk counterpart of `requestDelete`: one summary toast for the whole batch, and one Undo
   * that restores every item that was deleted. The confirm dialog and the plan live with the
   * item commands; this only runs the deletes and says what happened.
   */
  async function requestDeleteMany(items: readonly TreeItem[]): Promise<readonly string[]> {
    const outcome = await executeBulkDelete(tree, items);
    if (outcome.deleted.length === 0 && outcome.failed.length === 0) return [];
    shellToasts.push({
      key: `bulk-delete-${items.map((item) => item.id).join('-')}`,
      message: describeBulkDelete(outcome),
      ...(outcome.deleted.length === 0
        ? {}
        : {
            action: {
              label: 'Undo',
              onAction: () => {
                void undoBulkDeletion(outcome.deleted);
              },
            },
          }),
    });
    return outcome.deleted.map((item) => item.id);
  }

  async function undoBulkDeletion(deleted: readonly TreeItem[]): Promise<void> {
    const failed: string[] = [];
    for (const item of deleted) {
      const { refusal } = await tree.restore(item.id);
      if (refusal !== null) failed.push(item.title || 'Untitled');
    }
    if (failed.length > 0) {
      shellToasts.push({
        key: `bulk-restore-failed-${deleted[0]?.id ?? ''}`,
        message: `Restored ${String(deleted.length - failed.length)} of ${String(deleted.length)} items. "${failed[0] ?? ''}" could not be restored.`,
        autoFocus: false,
      });
    }
  }

  /**
   * What Undo actually does, and what it says when it fails.
   *
   * `<Toast>` dismisses itself the instant its action is pressed, whatever that action does - so by
   * the time `tree.restore` could possibly fail, the toast that offered Undo is already gone, and a
   * reader who pressed it has every reason to believe it worked. Saying nothing further would be
   * the same silent-failure shape `requestDelete` above exists to avoid, just one step later - so a
   * restore failure pushes its own notice, in the item's own name, rather than leaving the item
   * gone with only the tree's own foot-of-sidebar alert (`tree.error`) to explain it.
   *
   * `autoFocus: false` (see `ShellToast`'s own comment): the round trip to here - Undo pressed, the
   * request sent, the response awaited - is time enough for the reader to have moved on to
   * something else entirely, unlike the primary deletion toast this one follows, which mounts while
   * the row it names is still what just happened. `role="status"` is left as it is rather than
   * reached past for `role="alert"`, despite this being a genuine failure: `<Toast>` deliberately
   * has no severity axis (see its own doc), and there is nothing time-critical about the message
   * that would justify one - it is something to notice and possibly retry, not something that
   * needs to interrupt whatever the reader is doing right now, and `status`'s `aria-live="polite"`
   * still gets it announced regardless of not grabbing focus.
   */
  async function undoDeletion(itemId: string, title: string): Promise<void> {
    const { refusal } = await tree.restore(itemId);
    if (refusal !== null) {
      shellToasts.push({
        key: `${itemId}-restore-failed`,
        message: `"${title}" could not be restored.`,
        autoFocus: false,
      });
    }
  }

  useRevealOpenPanes(tree, panes);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * Creates an untitled note at the root and opens it - from the palette's command and from its
   * shortcut alike. Awaited for its answer, not fired and forgotten: `create` reports either an id
   * or a refusal, and dropping both meant a command that fired onto either a document nobody could
   * find or a silent failure - which is how people end up with six items called "Untitled".
   */
  function createUntitledNote(): void {
    void tree.create(null, 'Untitled note').then((outcome) => {
      if (outcome.id !== null) {
        openPreview(outcome.id);
        return;
      }

      const message = outcome.refusal ?? 'That could not be created.';
      // Both at once: the live region alone spoke only to a screen reader, and the palette has
      // already closed by the time this lands, so a sighted reader saw a command fire and then
      // nothing - the same silent-failure shape `requestDelete` above exists to avoid.
      announce(message);
      shellToasts.push({ key: 'new-note-failed', message });
    });
  }

  // Said once, here, whatever asked: the shortcut, the palette, the page's button and the exit
  // control all change the same store, and the layout change is otherwise silent to a screen reader.
  useEffect(
    () =>
      onZenModeChanged((on) => {
        announce(on ? 'Zen mode on' : 'Zen mode off');
      }),
    [],
  );
  useZenEscape(zen, () => {
    setZenMode(false);
  });

  useShellShortcuts({
    search: () => {
      setSearchOpen(true);
    },
    'new-note': createUntitledNote,
    'toggle-sidebar': sidebar.toggle,
    zen: toggleZenMode,
    back: () => {
      void navigate(-1);
    },
    forward: () => {
      void navigate(1);
    },
    shortcuts: () => {
      setShortcutsOpen(true);
    },
  });

  // The pet launcher (`pet-companion.tsx`) reads `--mobile-nav-height` to sit above the bottom
  // navigation rather than under it. No token names the nav's rendered height - it depends on the
  // PWA install/update banner above it (see `bottomChromeRef` below) as much as on the nav
  // itself - so it is measured here, where both live, rather than guessed at in the launcher.
  // Removed rather than left stale whenever the nav is not rendered (a wide screen, the software
  // keyboard covering it, or Zen having taken it away), so a leftover value from before a resize
  // never survives past the layout it was measured for.
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const navRendered = narrow && !keyboardVisible && !zen;
  useEffect(() => {
    const node = bottomChromeRef.current;
    if (!navRendered || !node) {
      document.documentElement.style.removeProperty('--mobile-nav-height');
      // Told, not just left to notice on its own next measurement: the pet launcher's dragged or
      // clamped position (`pet-companion.tsx`) reads this property once per resize rather than on
      // every render, so a value that goes stale without the nav resizing itself - the launcher's
      // own home going away entirely - needs its own signal to be picked up promptly.
      window.dispatchEvent(new Event('nix-mobile-nav-resized'));
      return;
    }
    const publish = (): void => {
      document.documentElement.style.setProperty(
        '--mobile-nav-height',
        `${String(node.getBoundingClientRect().height)}px`,
      );
      window.dispatchEvent(new Event('nix-mobile-nav-resized'));
    };
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      document.documentElement.style.removeProperty('--mobile-nav-height');
      window.dispatchEvent(new Event('nix-mobile-nav-resized'));
    };
  }, [navRendered]);

  return (
    // design-token-exempt: device safe-area insets protect content in portrait and landscape.
    <div
      style={visibleHeight === null ? undefined : { height: visibleHeight }} // design-token-exempt: the keyboard-reduced visual viewport height is measured at runtime.
      className="flex h-dvh flex-col overflow-hidden bg-background pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] font-body text-foreground"
    >
      {/* First focusable thing in the document, for everybody, on every screen. It used to live in
          a layout element that the route tree had stopped rendering, so in practice the app had no
          skip link at all.

          Every box property is re-applied under `focus:`, which looks redundant and is not:
          `.focus\:not-sr-only:focus` sets `padding: 0` at two-class specificity, so a plain `px-4`
          loses to it and the link paints as bare text in the very corner of the viewport - with the
          top and left of its focus ring outside the window, which is the one thing a focus
          indicator may not be. Offset from the corner and given elevation because it covers the
          header rather than sitting in the layout.

          The full stacking ladder, lowest to highest: pane content and the drawer's own scrim
          (`z-0`) < the drawer panel (`z-10`) < the profile menu (`z-20`) < the delete-undo toast
          (`z-[25]`, below) < the search overlay (`z-30`, `aria-modal="true"`) < this skip link
          (`z-50`). The drawer's own pair sit inside the pane row beside `<main>`, not inside
          `<main>` itself, but `<main>` carries `isolate` (below) precisely so nothing inside a pane
          - `sheet-grid.tsx`'s own `z-20`/`z-30`/`z-40` layers, or its drag overlay - can climb into
          the root context and outrank the header's popovers the way the drawer used to before it
          got its own numbers put in their place.

          The toast sits *below* the search overlay rather than above it, which used to be
          backwards: an earlier version of this comment argued the toast should outrank search
          because its undo window is time-limited, but the overlay it would have outranked is
          `role="dialog" aria-modal="true"` - telling assistive technology that everything outside
          it, the toast included, is unavailable for as long as it is open. A toast that visually
          sat on top of that while being declared unreachable by the platform's own modality
          contract was the contradiction, not the ordering. The honest trade-off this ladder now
          encodes: opening search while a toast is showing costs the toast's visibility for as long
          as search stays open, exactly as it costs every other item behind the dialog - the timer
          underneath keeps running regardless, so a long search session can still let the window
          close unseen, which is the correct read of "unavailable while the dialog is open" rather
          than a difference this ordering tries to paper over. `z-50` clears all of them, being the
          one control that must never be covered. */}
      {/* One live region for the whole shell, mounted for the session. The things it reads -
          a pane opened, a pane closed, a control refusing - happen in components that come and go,
          and a region that unmounted with them would take the message with it. Polite, because it
          reports a change the reader asked for rather than interrupting one they did not.

          Never keyed and never conditionally rendered. A live region has to be in the
          accessibility tree before its contents change; one that appears together with its text is
          the canonical reason a region says nothing at all. Saying the same thing twice is handled
          in the announcer, by varying the string rather than the element. */}
      <p aria-live="polite" className="sr-only">
        {announcement.text}
      </p>

      {/* In Zen the exit control is the first thing Tab reaches, and the skip link is not drawn:
          with the rail, tree and header gone there is nothing between the top of the page and the
          content for it to skip. */}
      {zen ? (
        <ZenExit />
      ) : (
        <a
          href="#main"
          onClick={(event) => {
            // `#main` is `inert` while the drawer covers it (see the `<main>` element below), so the
            // browser's own anchor-jump would land focus nowhere - the one thing "skip to content" is
            // for. Dismissing the drawer is part of getting to the content it is covering, the same
            // reading the sidebar's row-selection path gives it, so this closes it and sends
            // focus to the pane exactly as that path does. Left alone everywhere else: on a wide
            // screen, or a narrow one with the drawer already closed, `<main>` was never inert and the
            // default jump already works.
            if (narrow && sidebar.visible) {
              event.preventDefault();
              sidebar.toggle();
              focusPane(0);
              requestAnimationFrame(() => {
                if (!mainRef.current?.contains(document.activeElement)) {
                  mainRef.current?.focus({ preventScroll: true });
                }
              });
            }
          }}
          className={`sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-md ${focusRing}`}
        >
          Skip to content
        </a>
      )}

      {/* The rail, then everything else. This row exists so the rail can run the full height of
          the window at the very left edge - outboard of the workspace tree, alongside the header
          rather than under it - which is the whole point of a rail: the destinations that are not
          a document stay put while the tree scrolls, resizes, or slides away.

          It sits *after* the skip link in the document, not before, because the skip link must
          stay the first focusable thing on the page; and *outside* the pane row below, so the
          drawer's scrim - which is `absolute inset-0` of that row - does not cover it. That is the
          same call the header already makes for its own controls: the way out of the drawer must
          not be the thing the drawer covers.

          `min-h-0` so this row can shrink inside the `h-dvh` column, which is what gives the pane
          row underneath a definite height to scroll against. */}
      <div className="flex min-h-0 flex-1">
        {!zen && !narrow ? (
          <NavRail
            onImport={() => {
              setWorkspaceImportOpen(true);
            }}
          />
        ) : null}

        <div className={`flex flex-1 flex-col ${paneClip}`}>
          {zen ? null : (
            <div hidden={keyboardVisible}>
              <ShellHeader
                sidebarVisible={sidebar.visible}
                sidebarToggleRef={sidebarToggleRef}
                workspaceId={workspaceId}
                principal={principal}
                unreadNotifications={notificationsInbox.unread}
                onToggleSidebar={sidebar.toggle}
                onOpenSearch={() => {
                  setSearchOpen(true);
                }}
                onOpenInbox={() => {
                  setInboxOpen(true);
                }}
              />
            </div>
          )}
          <WorkspaceInvitationNotice />

          {/* `relative`, so the drawer's scrim and panel - `absolute inset-*` - anchor to this row
              rather than to the viewport. That keeps the overlay below the header, over the pane
              content only: a phone has no room to share the tree beside a document, but the header's
              own toggle button is what closes the drawer, and covering it would take away the way
              back. */}
          {/* Nothing of a workspace is shown before its invitation is accepted. */}
          {workspace.pendingInvitationId !== null ? null : (
            <div className={`relative flex flex-1 ${paneClip}`}>
              {/* Around the sidebar as well as the panes: both draw the selection tray, and both
                run move and delete through these commands. */}
              <ItemCommandsProvider
                tree={tree}
                onDeleteItem={(item) => {
                  void requestDelete(item);
                }}
                onDeleteItems={requestDeleteMany}
              >
                {zen ? null : (
                  <ShellSidebar
                    key={workspaceId}
                    narrow={narrow}
                    mobileDestinations={
                      <NavRail
                        compact
                        onImport={() => {
                          // Keep one Back entry while the drawer hands off to Import.
                          sidebarToggleRef.current?.focus();
                          flushSync(() => {
                            sidebar.toggle();
                            setWorkspaceImportOpen(true);
                          });
                        }}
                        onNavigate={() => {
                          sidebar.toggle();
                          focusPane(0);
                        }}
                      />
                    }
                    sidebar={sidebar}
                    tree={tree}
                    selectedId={selectedId}
                    openItem={{ openPreview, openPinned, openBeside, canOpenBeside, besideRefusal }}
                    onDeleteItem={(item) => {
                      void requestDelete(item);
                    }}
                    onStartStructured={startStructured}
                    templates={templateLibrary.templates.filter(
                      (template) => template.capabilities.canApply,
                    )}
                    templateStatus={templateLibrary.status}
                    onStartTemplate={startTemplate}
                    onBrowseTemplates={browseTemplates}
                    treeRegionRef={treeRegionRef}
                    sidebarToggleRef={sidebarToggleRef}
                  />
                )}

                {/* The shell owns the main landmark so every screen has exactly one, and a screen that
                renders panels side by side does not have to nest them inside another.

                `inert` while the drawer is open: the native (React 19) way of making this region
                genuinely unreachable to pointer and assistive technology without a hand-rolled focus
                trap standing in for it - see `sidebar-drawer.tsx`'s own comment on why that trade was
                made. Scoped to the drawer being open rather than to `narrow` alone, since a narrow
                window with the drawer closed has nothing covering this region at all.

                `isolate` unconditionally, not only while the drawer is open: it creates a stacking
                context for everything a pane renders, so nothing in here - `sheet-grid.tsx`'s own
                `z-20`/`z-30`/`z-40` layers, or its drag overlay - can ever resolve into the *root*
                stacking context and paint over the header's own popovers. This is a different fix
                from the drawer's: the drawer sits *beside* `<main>`, not inside it, so `isolate` here
                does nothing for the drawer's own stacking - that was corrected separately, by giving
                the drawer numbers low enough to lose to the header outright (see the skip link's
                comment above for the full ladder). `isolation: isolate` does not change the containing
                block for `position: fixed`, so a fixed drag overlay still covers the viewport
                geometrically - this only stops it from painting above chrome that lives outside
                `<main>`. */}
                <main
                  ref={mainRef}
                  id="main"
                  tabIndex={-1}
                  inert={narrow && sidebar.visible && !zen}
                  className={`isolate flex flex-1 ${paneClip}`}
                >
                  {/* Mutable server-owned template state has its own subscribed context. Router
                  Outlet context is retained for shell-owned navigation state only, so an async
                  catalog response cannot leave a mounted screen holding the initial capability
                  snapshot. */}
                  <TemplateLibraryProvider library={templateLibrary}>
                    <CapabilitiesProvider value={capabilities}>
                      <ItemDialogProvider tree={tree}>
                        <Outlet context={{ tree, selectedId } satisfies ShellContext} />
                      </ItemDialogProvider>
                    </CapabilitiesProvider>
                  </TemplateLibraryProvider>
                </main>
              </ItemCommandsProvider>
            </div>
          )}
        </div>
      </div>

      {/* The region `bottomChromeRef` measures for `--mobile-nav-height`: the PWA banner sits
          above the nav in normal block flow, so a single ref around both is what lets the
          launcher clear whichever of them is actually showing above it. */}
      <div ref={bottomChromeRef}>
        {/* In this region, not over content: it takes its own row, so the pet launcher, which
            clears this region's measured height, clears the player too. Hidden while the software
            keyboard is up, when the room is better spent on the text being typed. */}
        {keyboardVisible || zen ? null : <MiniPlayer onOpen={openPinned} />}
        {zen ? null : <PwaControls />}
        {navRendered ? (
          <MobileNavigation
            workspaceId={workspaceId}
            treeOpen={sidebar.visible}
            creating={tree.isCreating}
            unreadNotifications={notificationsInbox.unread}
            pet={
              petEntry && {
                label: petEntry.label,
                attention: petEntry.attention && petAttentionText(petEntry.attention),
              }
            }
            onTree={sidebar.toggle}
            onSearch={() => {
              setSearchOpen(true);
            }}
            onCreate={() => {
              if (sidebar.visible) sidebar.toggle();
              setCaptureOpen(true);
            }}
            onOpenInbox={() => {
              setInboxOpen(true);
            }}
          />
        ) : null}
      </div>

      <MobileNoteCapture
        key={`capture:${workspaceId}`}
        open={captureOpen}
        tree={tree}
        onClose={() => {
          setCaptureOpen(false);
        }}
        onCreated={openPreview}
      />

      {workspaceImportOpen ? (
        <ImportDialog
          open
          parentId={null}
          getAccessToken={getAccessToken}
          onClose={() => {
            setWorkspaceImportOpen(false);
          }}
          onImported={(rootItemId) => {
            // Reveal the imported vault without opening it over the report the person is still
            // reading. This is the same promise as a contextual import inside an open note.
            void tree.reveal(rootItemId);
          }}
        />
      ) : null}

      <CommandPalette
        key={workspaceId}
        preserveQuery={narrow}
        open={searchOpen}
        commands={builtInCommands({
          // Built here rather than inside the palette, because the shell is what holds each of
          // these. A palette that reached for them itself would be a second owner of the sidebar's
          // state and a second caller of the tree's create.
          createItem: createUntitledNote,
          toggleSidebar: sidebar.toggle,

          // Null when nothing is open, so the command is left out of the list rather than offered
          // and inert. See commands.ts for why that distinction is worth a nullable.
          toggleBookmark:
            selectedId === null
              ? null
              : () => {
                  void toggleBookmark(selectedId);
                },
          openItemIsKept: selectedIsKept,
          openToday: workspace.canUseDailyNotes
            ? () => {
                void navigate(`/w/${workspaceId}/daily`);
              }
            : null,
          captureToToday: workspace.canUseDailyNotes
            ? () => {
                setDailyCaptureOpen(true);
              }
            : null,
          openShortcuts: () => {
            setShortcutsOpen(true);
          },
          toggleZen: toggleZenMode,
          openAutomations: () => {
            void navigate(automationsHref(workspaceId, { kind: 'list' }));
          },
          automateOpenItem:
            selectedId === null
              ? null
              : () => {
                  void navigate(
                    automationsHref(workspaceId, { kind: 'new', scopeItemId: selectedId }),
                  );
                },
        })}
        onSelectItem={openPreview}
        onClose={() => {
          setSearchOpen(false);
        }}
      />

      <DailyCaptureDialog
        open={dailyCaptureOpen}
        workspaceId={workspaceId}
        onClose={() => {
          setDailyCaptureOpen(false);
        }}
        onOpenItem={openPinned}
      />

      <NotificationInboxPanel
        open={inboxOpen}
        onClose={() => {
          setInboxOpen(false);
        }}
        inbox={notificationsInbox}
        onOpenItem={openPreview}
        onOpenWorkspace={(id) => {
          // An invitation that arrived after sign-in is not in the loaded list yet.
          reloadWorkspaces();
          void navigate(`/w/${id}`);
        }}
      />

      <KeyboardShortcutsDialog
        open={shortcutsOpen}
        onClose={() => {
          setShortcutsOpen(false);
        }}
      />

      <ShellToasts
        toasts={shellToasts.toasts}
        treeRegionRef={treeRegionRef}
        onDismiss={shellToasts.dismiss}
        onViewReminders={() => {
          setInboxOpen(true);
        }}
      />
    </div>
  );
}
