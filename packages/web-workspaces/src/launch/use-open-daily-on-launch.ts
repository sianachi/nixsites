import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { browserSessionStorage } from '@nix/web-foundation/lib/browser-storage';
import { readOpenDailyOnLaunch } from '@nix/web-foundation/lib/daily-note-device-preferences';
import { useWorkspace } from '../workspaces/workspace-context';

/** Present once the browser session has had its start; sessionStorage is what scopes it to one. */
const LAUNCHED_KEY = 'nix.daily.launched';

/**
 * Takes the first workspace screen of a browser session to today's note, when this device asks for
 * that.
 *
 * **The shell's first mount is the start.** Whatever address Nix was opened at, that is the first
 * time it shows a workspace, so the session is marked started right there. Only a bare workspace
 * address is redirected: an item, a destination, any query (a launch from a share sheet or a
 * shortcut carries one) or navigation state (the Search shortcut's) is somewhere the person asked
 * to be, and a launch address is not the bare index at all, so a launch intent always wins. Because
 * a deep link also marks the session, coming back to the workspace index later in it is never
 * taken for a start.
 *
 * Replaces rather than pushes, so Back from today's note leaves the app instead of returning to an
 * index that would send the person on again.
 */
export function useOpenDailyOnLaunch(): void {
  const { workspaceId, workspace } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const session = browserSessionStorage();
    try {
      if (session?.getItem(LAUNCHED_KEY) === '1') return;
      session?.setItem(LAUNCHED_KEY, '1');
    } catch {
      // Storage that throws leaves only this mount's guard, which is enough for one shell.
    }
    const home = `/w/${workspaceId}`;
    const bare =
      location.pathname.replace(/\/$/u, '') === home &&
      location.search === '' &&
      location.hash === '' &&
      location.state === null;
    if (bare && workspace.canUseDailyNotes && readOpenDailyOnLaunch()) {
      void navigate(`${home}/daily`, { replace: true });
    }
    // Decided once, from where the shell first mounted; later navigation is the person's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decided once, from where the shell first mounted.
  }, []);
}
