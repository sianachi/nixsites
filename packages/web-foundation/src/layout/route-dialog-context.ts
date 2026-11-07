import { createContext, useContext } from 'react';
import type { Location, NavigationType } from 'react-router';

/** The workspace screens that open over the work on desktop and as pages everywhere else. */
export type RouteDialogKind = 'attachments' | 'automations' | 'settings' | 'trash' | 'workspaces';

export interface RouteDialogState {
  readonly kind: RouteDialogKind;
  /** The real address, the dialog's own. The rest of the shell is shown at the work's address. */
  readonly location: Location;
  readonly navigationType: NavigationType;
  /** Back to the work the dialog opened over. */
  readonly close: () => void;
}

/** Set by `AppRoutes` while one of these screens is open as a dialog; null otherwise. */
export const RouteDialogContext = createContext<RouteDialogState | null>(null);

export function useRouteDialog(): RouteDialogState | null {
  return useContext(RouteDialogContext);
}

/**
 * True inside a screen shown as a dialog. The dialog supplies the title, the close control and the
 * outer padding, so the screen leaves out its own page heading and margins.
 */
export const InRouteDialogContext = createContext(false);

export function useInRouteDialog(): boolean {
  return useContext(InRouteDialogContext);
}
