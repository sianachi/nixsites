import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { Button, Text } from '@nix/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { useWorkspace } from './workspace-context';

export function WorkspaceInvitationNotice(): ReactNode {
  const client = useApiClient();
  const navigate = useNavigate();
  const context = useWorkspace();
  const { workspace } = context;
  const [working, setWorking] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  const invitationId = workspace.pendingInvitationId;
  if (invitationId === null) return null;
  const pendingInvitationId: string = invitationId;

  async function respond(response: 'accept' | 'decline'): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setWorking(response);
    setError(null);
    try {
      const endpoint =
        response === 'accept'
          ? coreWorkspaces.acceptInvitation(workspace.id, pendingInvitationId)
          : coreWorkspaces.declineInvitation(workspace.id, pendingInvitationId);
      await client.execute(endpoint, { signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      if (response === 'decline') {
        context.workspaceRemoved(workspace.id);
        void navigate('/');
      } else {
        context.workspaceUpdated({ ...workspace, pendingInvitationId: null });
        context.reload();
      }
    } catch (reason) {
      if (controller.signal.aborted || isCanceledError(reason)) return;
      setError(
        isNixApiError(reason)
          ? (reason.detail ?? 'Your invitation response could not be saved.')
          : 'Your invitation response could not be saved.',
      );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setWorking(null);
      }
    }
  }

  return (
    <aside
      aria-label="Workspace invitation"
      aria-busy={working !== null}
      className="flex flex-wrap items-center gap-2 bg-surface px-3 py-2 shadow-sm sm:px-4"
    >
      <Text className="min-w-0 flex-1">
        You were invited to {workspace.name}. Accept to join it, or decline.
      </Text>
      <Button
        variant="secondary"
        disabled={working !== null}
        onClick={() => void respond('decline')}
      >
        {working === 'decline' ? 'Declining…' : 'Decline'}
      </Button>
      <Button disabled={working !== null} onClick={() => void respond('accept')}>
        {working === 'accept' ? 'Accepting…' : 'Accept'}
      </Button>
      {error === null ? null : (
        <Text role="alert" className="w-full" tone="muted">
          {error}
        </Text>
      )}
    </aside>
  );
}
