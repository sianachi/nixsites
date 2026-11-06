import { Dialog } from '@nix/ui';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  matchPath,
  NavigationType,
  UNSAFE_LocationContext,
  useLocation,
  useNavigate,
  useNavigationType,
  type Location,
} from 'react-router';

import { useLayoutKind } from '@nix/web-foundation/layout/viewport';
import { AutomationsPage } from '../automations/automations-page';
import { AttachmentsPage } from '../pages/attachments-page';
import { SettingsPage } from '../pages/settings-page';
import { TrashPage } from '../pages/trash-page';
import { WorkspacesPage } from '../pages/workspaces-page';
import {
  InRouteDialogContext,
  useRouteDialog,
  type RouteDialogKind,
  type RouteDialogState,
} from './route-dialog-context';

/**
 * Automations, workspaces, trash and settings: dialogs over the work on desktop, pages on phones
 * and tablets.
 *
 * Each keeps its own address (`/w/:id/settings` and so on), so a link, a refresh and system back
 * behave exactly as they do for a page. On desktop `AppRoutes` renders the rest of the app at the
 * address of the work the person was on - the last address that was not one of these - and this
 * module shows the screen in a `<Dialog>` above it. A deep link has no such work, so the
 * workspace's own home stands in.
 *
 * The screen inside the dialog reads the real address through React Router's location context,
 * which is why that one `UNSAFE_` export is used: `<Routes location>` gives the work its address,
 * and the screen needs the other one for its own search params (`?tab=`, `?rule=`).
 */

const KINDS: ReadonlySet<string> = new Set<RouteDialogKind>([
  'attachments',
  'automations',
  'settings',
  'trash',
  'workspaces',
]);

export function routeDialogOf(
  pathname: string,
): { readonly workspaceId: string; readonly kind: RouteDialogKind } | null {
  const match = matchPath('/w/:workspaceId/:screen', pathname);
  const workspaceId = match?.params.workspaceId;
  const screen = match?.params.screen;
  if (workspaceId === undefined || screen === undefined || !KINDS.has(screen)) return null;
  return { workspaceId, kind: screen as RouteDialogKind };
}

/**
 * The work the dialog opens over, and how many history entries were pushed on top of it since -
 * so closing can step back to it rather than push it again. `depth` is null when that count is
 * unknown: a deep link, a Back or Forward into the dialog, or a replace of the work's own entry.
 */
interface Trail {
  readonly key: string;
  readonly work: Location | null;
  readonly depth: number | null;
}

function follow(trail: Trail | null, location: Location, type: NavigationType): Trail {
  if (routeDialogOf(location.pathname) === null) {
    return { key: location.key, work: location, depth: 0 };
  }
  if (trail === null) return { key: location.key, work: null, depth: null };
  const depth =
    trail.depth === null
      ? null
      : type === NavigationType.Push
        ? trail.depth + 1
        : type === NavigationType.Replace && trail.depth > 0
          ? trail.depth
          : null;
  return { key: location.key, work: trail.work, depth };
}

function inWorkspace(location: Location, workspaceId: string): boolean {
  return (
    matchPath({ path: '/w/:workspaceId', end: false }, location.pathname)?.params.workspaceId ===
    workspaceId
  );
}

/**
 * For `AppRoutes`: the location to render the app at, and the dialog to show over it, if any.
 * Only a desktop layout gets the dialog; anywhere else the screen is the page at its own address.
 */
export function useRouteDialogRouting(): {
  readonly mainLocation: Location;
  readonly dialog: RouteDialogState | null;
} {
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const desktop = useLayoutKind() === 'desktop';

  const [trail, setTrail] = useState<Trail>(() => follow(null, location, navigationType));
  let current = trail;
  if (trail.key !== location.key) {
    // Adjusted during render, React's pattern for state that follows a changed input.
    current = follow(trail, location, navigationType);
    setTrail(current);
  }

  const match = desktop ? routeDialogOf(location.pathname) : null;
  const workspaceId = match?.workspaceId;
  const fromHistory =
    workspaceId !== undefined && current.work !== null && inWorkspace(current.work, workspaceId);
  const background = useMemo<Location | null>(() => {
    if (workspaceId === undefined) return null;
    if (fromHistory && current.work !== null) return current.work;
    return {
      pathname: `/w/${encodeURIComponent(workspaceId)}`,
      search: '',
      hash: '',
      state: null,
      key: 'route-dialog-home',
    };
  }, [workspaceId, fromHistory, current.work]);

  const depth = fromHistory ? current.depth : null;
  const close = useCallback(() => {
    if (background === null) return;
    if (depth !== null && depth > 0) {
      void navigate(-depth);
    } else {
      void navigate(`${background.pathname}${background.search}${background.hash}`);
    }
  }, [navigate, background, depth]);

  const kind = match?.kind;
  const dialog = useMemo<RouteDialogState | null>(
    () => (kind === undefined ? null : { kind, location, navigationType, close }),
    [kind, location, navigationType, close],
  );

  return { mainLocation: background ?? location, dialog };
}

const SCREENS: Record<
  RouteDialogKind,
  { readonly title: string; readonly width: string; readonly Screen: () => ReactNode }
> = {
  attachments: { title: 'Attachments', width: 'sm:max-w-4xl', Screen: AttachmentsPage },
  automations: { title: 'Automations', width: 'sm:max-w-5xl', Screen: AutomationsPage },
  settings: { title: 'Settings', width: 'sm:max-w-5xl', Screen: SettingsPage },
  trash: { title: 'Trash', width: 'sm:max-w-3xl', Screen: TrashPage },
  workspaces: { title: 'Workspaces', width: 'sm:max-w-2xl', Screen: WorkspacesPage },
};

/** The open screen, as a dialog. Rendered inside the shell, so it has the shell's providers. */
export function RouteDialog(): ReactNode {
  const dialog = useRouteDialog();
  const realLocation = useMemo(
    () =>
      dialog === null ? null : { location: dialog.location, navigationType: dialog.navigationType },
    [dialog],
  );
  if (dialog === null || realLocation === null) return null;
  const { title, width, Screen } = SCREENS[dialog.kind];
  return (
    <UNSAFE_LocationContext.Provider value={realLocation}>
      <InRouteDialogContext.Provider value>
        <Dialog
          key={dialog.kind}
          open
          title={title}
          presentation="workspace"
          onClose={dialog.close}
          className={width}
        >
          <Screen />
        </Dialog>
      </InRouteDialogContext.Provider>
    </UNSAFE_LocationContext.Provider>
  );
}
