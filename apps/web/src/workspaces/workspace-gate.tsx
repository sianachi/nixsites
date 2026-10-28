import { useSessionStore } from '../auth/session-store';
import { readLastLocation } from '../pwa/last-location';
import { Button } from '@nix/ui';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '../components/states/status-panels';
import { SHARE_PARAMETERS } from '../launch/launch-intent';
import { readLastWorkspaceId } from './last-workspace';
import { useAccessibleWorkspaces, WorkspaceProvider } from './workspace-context';

// `tab` joins this list for the same reason `state`, `grain`, `on` and `notes` are here: it picks
// a view within a page - the settings screen's own tabs - rather than naming a resource, so a
// bare, not-yet-workspace-scoped deep link (`/settings?tab=notifications`) should carry it through
// the legacy redirect below rather than silently drop it.
const INDEPENDENT_QUERY = /^(?:state|grain|on|notes|q|tab)$/;
const RESOURCE_QUERY =
  /^(?:item\d*|view\d*|mode\d*|sort\d*|dir\d*|filter(?:\.|\d)|split|sizes|parent|target|sourceItem)$/;

export function safeLegacySearch(search: string, preserveResources: boolean): string {
  const params = new URLSearchParams(search);
  for (const name of [...params.keys()]) {
    if (!INDEPENDENT_QUERY.test(name) && !(preserveResources && RESOURCE_QUERY.test(name))) {
      params.delete(name);
    }
  }
  const value = params.toString();
  return value.length === 0 ? '' : `?${value}`;
}

/** Keeps only a share launch's own parameters, dropping anything else a sharing app appended. */
export function launchSearch(search: string): string {
  const incoming = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const name of SHARE_PARAMETERS) {
    const value = incoming.get(name);
    if (value !== null) kept.set(name, value);
  }
  const value = kept.toString();
  return value.length === 0 ? '' : `?${value}`;
}

function WorkspaceStateFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return <main className="mx-auto flex min-h-dvh max-w-3xl items-center p-6">{children}</main>;
}

export function LegacyWorkspaceRedirect(): ReactNode {
  const state = useAccessibleWorkspaces();
  const location = useLocation();
  const subject = useSessionStore((state) => state.profile?.subject);

  if (state.status === 'loading') {
    return (
      <WorkspaceStateFrame>
        <LoadingPanel label="your workspaces" />
      </WorkspaceStateFrame>
    );
  }
  if (state.status === 'error') {
    return (
      <WorkspaceStateFrame>
        <ErrorPanel
          title="Your workspaces could not be loaded"
          detail={state.error ?? 'Try again.'}
          action={
            <Button variant="secondary" onClick={state.reload}>
              Try again
            </Button>
          }
        />
      </WorkspaceStateFrame>
    );
  }
  if (state.status === 'empty') {
    return (
      <WorkspaceStateFrame>
        <EmptyPanel
          title="No workspace is available"
          detail="Your account is active, but no workspace is available yet. Ask a tenant administrator to check provisioning."
        />
      </WorkspaceStateFrame>
    );
  }

  const saved =
    subject && location.pathname === '/' && location.search === '' && location.hash === ''
      ? readLastLocation(
          subject,
          state.workspaces
            .filter(
              (workspace) =>
                workspace.lifecycleState === 'active' && workspace.pendingInvitationId === null,
            )
            .map((workspace) => workspace.id),
        )
      : null;
  if (saved) return <Navigate replace to={saved} />;

  const remembered = readLastWorkspaceId();
  // A pending invitation is never opened on its own: only when the invitee chooses to answer it.
  const activeWorkspaces = state.workspaces.filter(
    (workspace) => workspace.lifecycleState === 'active' && workspace.pendingInvitationId === null,
  );
  if (activeWorkspaces.length === 0) return <Navigate replace to="/workspaces/archived" />;
  const rememberedWorkspace = activeWorkspaces.find((workspace) => workspace.id === remembered);
  const selected =
    rememberedWorkspace ??
    activeWorkspaces.find((workspace) => workspace.kind === 'personal') ??
    activeWorkspaces[0];
  if (selected === undefined) return null;

  const suffix = location.pathname === '/' ? '' : location.pathname;
  // A launch carries what was shared in its query; every other legacy address has it scrubbed.
  const search = location.pathname.startsWith('/launch/')
    ? launchSearch(location.search)
    : safeLegacySearch(location.search, rememberedWorkspace !== undefined);
  return <Navigate replace to={`/w/${selected.id}${suffix}${search}${location.hash}`} />;
}

export function WorkspaceGate({ children }: { readonly children: ReactNode }): ReactNode {
  const state = useAccessibleWorkspaces();
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();

  if (state.status === 'loading') {
    return (
      <WorkspaceStateFrame>
        <LoadingPanel label="this workspace" />
      </WorkspaceStateFrame>
    );
  }
  if (state.status === 'error') {
    return (
      <WorkspaceStateFrame>
        <ErrorPanel
          title="This workspace could not be opened"
          detail={state.error ?? 'Try again.'}
          action={
            <Button variant="secondary" onClick={state.reload}>
              Try again
            </Button>
          }
        />
      </WorkspaceStateFrame>
    );
  }
  if (state.status === 'empty') {
    return (
      <WorkspaceStateFrame>
        <EmptyPanel
          title="No workspace is available"
          detail="Your account is active, but no workspace is available yet. Ask a tenant administrator to check provisioning."
        />
      </WorkspaceStateFrame>
    );
  }

  const current = state.workspaces.find((workspace) => workspace.id === workspaceId);
  if (current === undefined) {
    if (state.status === 'partial') {
      return (
        <WorkspaceStateFrame>
          <ErrorPanel
            title="Workspace access could not be checked"
            detail="The accessible workspace list is incomplete, so Nix cannot yet tell whether this workspace is available."
            action={
              <Button variant="secondary" onClick={state.reload}>
                Try again
              </Button>
            }
          />
        </WorkspaceStateFrame>
      );
    }
    const fallback =
      state.workspaces.find((workspace) => workspace.kind === 'personal') ?? state.workspaces[0];
    return (
      <WorkspaceStateFrame>
        <ErrorPanel
          title="Workspace not found"
          detail="This workspace is unavailable or you do not have access to it."
          action={
            fallback === undefined ? undefined : (
              <Button
                variant="secondary"
                onClick={() => {
                  void navigate(`/w/${fallback.id}`);
                }}
              >
                Switch workspace
              </Button>
            )
          }
        />
      </WorkspaceStateFrame>
    );
  }

  if (current.lifecycleState !== 'active') {
    return (
      <WorkspaceStateFrame>
        <ErrorPanel
          title={
            current.lifecycleState === 'purging'
              ? 'Workspace is being deleted'
              : 'Workspace is archived'
          }
          detail={
            current.lifecycleState === 'purging'
              ? 'This workspace is being permanently deleted and cannot be opened.'
              : 'Restore this workspace from Archived workspaces before opening it.'
          }
          action={
            <Link to="/workspaces/archived">
              <Button variant="secondary">Archived workspaces</Button>
            </Link>
          }
        />
      </WorkspaceStateFrame>
    );
  }

  return (
    <WorkspaceProvider key={current.id} state={state}>
      {state.status === 'partial' ? (
        <div className="fixed right-4 top-4 z-50 max-w-lg">
          <PartialNotice pending={state.error ?? 'The workspace list may be incomplete.'} />
        </div>
      ) : null}
      {children}
    </WorkspaceProvider>
  );
}
