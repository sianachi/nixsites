import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { announce } from '@nix/web-foundation/a11y/announcer';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { usePaneIndex } from '@nix/web-platform/panes/pane-context';
import { CHAT_PARAM, focusPane, paneParam } from '@nix/web-platform/panes/pane-params';
import { parsePanes } from '@nix/web-platform/panes/pane-state';
import { ownerOfItem } from '@nix/web-platform/panes/tab-ownership';
import { chatTabId, useTabStore } from '@nix/web-foundation/lib/tab-store';

/**
 * Opens the companion conversation as a tab in a pane: `null` is the workspace conversation, an
 * item id the one about that note.
 *
 * A conversation already open in a pane is focused there, never opened twice (one runtime per
 * conversation). Where the tab strip is not drawn - a narrow window or Zen - or no pane is open,
 * the conversation opens as the companion page instead, which is where it lived before it could
 * be a tab.
 */
export function useOpenChat(): (rootItemId: string | null) => void {
  const pane = usePaneIndex();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const narrow = useNarrowViewport();
  const zen = useZenActive();
  const byPane = useTabStore((state) => state.byPane);
  const tabPinned = useTabStore((state) => state.tabPinned);
  const editorPath = /^\/w\/[^/]+/.exec(location.pathname)?.[0] ?? '/';

  return (rootItemId) => {
    const scope = rootItemId ?? 'workspace';
    const id = chatTabId(scope);
    const panes = parsePanes(searchParams).panes;
    const target = ownerOfItem(id, panes, byPane) ?? pane;
    const shown = panes.find((candidate) => candidate.index === target);

    if (location.pathname !== editorPath || narrow || zen || shown === undefined) {
      void navigate(
        `${editorPath}/pet${rootItemId === null ? '' : `?root=${encodeURIComponent(rootItemId)}`}`,
      );
      return;
    }

    tabPinned(target, id);
    if (shown.chat !== scope) {
      const next = new URLSearchParams(searchParams);
      next.set(paneParam(CHAT_PARAM, target), scope);
      setSearchParams(next);
    }
    if (target !== pane) {
      announce(`Already open in pane ${String(target + 1)}.`);
      focusPane(target);
    }
  };
}
