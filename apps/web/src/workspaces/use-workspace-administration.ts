import {
  isCanceledError,
  isNixApiError,
  workspaces as coreWorkspaces,
  type WorkspaceInvitation,
  type WorkspaceInvitee,
  type WorkspaceMember,
} from '@nix/api-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '../api/api-client-provider';
import { useWorkspace } from './workspace-context';

type LoadStatus = 'loading' | 'ready' | 'partial' | 'error';

function problem(error: unknown, fallback: string): string {
  return isNixApiError(error) ? (error.detail ?? fallback) : fallback;
}

export interface WorkspaceAdministration {
  readonly membersStatus: LoadStatus;
  readonly invitationsStatus: LoadStatus;
  readonly inviteesStatus: LoadStatus;
  readonly members: readonly WorkspaceMember[];
  readonly invitations: readonly WorkspaceInvitation[];
  readonly invitees: readonly WorkspaceInvitee[];
  readonly membersError: string | null;
  readonly invitationsError: string | null;
  readonly inviteesError: string | null;
  readonly mutationError: string | null;
  readonly mutationNotice: string | null;
  readonly working: boolean;
  readonly reload: () => void;
  readonly rename: (name: string) => Promise<boolean>;
  readonly invite: (principalId: string, role: 'owner' | 'editor' | 'viewer') => Promise<boolean>;
  readonly revokeInvitation: (invitationId: string) => Promise<boolean>;
  readonly changeRole: (
    principalId: string,
    role: 'owner' | 'editor' | 'viewer',
  ) => Promise<boolean>;
  readonly removeMember: (principalId: string) => Promise<boolean>;
  readonly leave: () => Promise<boolean>;
  readonly archive: () => Promise<boolean>;
}

export function useWorkspaceAdministration(inviteeQuery = ''): WorkspaceAdministration {
  const client = useApiClient();
  const { workspaceId, workspace, reload: reloadWorkspaces, workspaceUpdated } = useWorkspace();
  const [reloadKey, setReloadKey] = useState(0);
  const [membersStatus, setMembersStatus] = useState<LoadStatus>('loading');
  const [invitationsStatus, setInvitationsStatus] = useState<LoadStatus>('loading');
  const [inviteesStatus, setInviteesStatus] = useState<LoadStatus>('loading');
  const [members, setMembers] = useState<readonly WorkspaceMember[]>([]);
  const [invitations, setInvitations] = useState<readonly WorkspaceInvitation[]>([]);
  const [invitees, setInvitees] = useState<readonly WorkspaceInvitee[]>([]);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [inviteesError, setInviteesError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationNotice, setMutationNotice] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mounted = useRef(true);
  const mutations = useRef(new Set<AbortController>());

  useEffect(() => {
    mounted.current = true;
    const pendingMutations = mutations.current;
    return () => {
      mounted.current = false;
      for (const controller of pendingMutations) controller.abort();
      pendingMutations.clear();
    };
  }, []);

  useEffect(() => {
    if (!workspace.canManageMembers) {
      queueMicrotask(() => {
        setMembers([]);
        setInvitations([]);
        setInvitees([]);
        setMembersError(null);
        setInvitationsError(null);
        setInviteesError(null);
        setMembersStatus('ready');
        setInvitationsStatus('ready');
        setInviteesStatus('ready');
      });
      return;
    }

    const controller = new AbortController();
    queueMicrotask(() => {
      setMembersStatus('loading');
      setInvitationsStatus('loading');
      setInviteesStatus('loading');
      setMembersError(null);
      setInvitationsError(null);
      setInviteesError(null);
    });
    void (async () => {
      const nextMembers: WorkspaceMember[] = [];
      try {
        for await (const member of client.paginate(coreWorkspaces.listMembers(workspaceId), {
          signal: controller.signal,
        })) {
          nextMembers.push(member);
        }
        if (controller.signal.aborted) return;
        setMembers(nextMembers);
        setMembersStatus('ready');
      } catch (reason) {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setMembers(nextMembers);
        setMembersError(problem(reason, 'Workspace members could not be loaded.'));
        setMembersStatus(nextMembers.length === 0 ? 'error' : 'partial');
      }
    })();

    void (async () => {
      const nextInvitations: WorkspaceInvitation[] = [];
      try {
        for await (const invitation of client.paginate(
          coreWorkspaces.listInvitations(workspaceId),
          { signal: controller.signal },
        )) {
          nextInvitations.push(invitation);
        }
        if (controller.signal.aborted) return;
        setInvitations(nextInvitations);
        setInvitationsStatus('ready');
      } catch (reason) {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setInvitations(nextInvitations);
        setInvitationsError(problem(reason, 'Workspace invitations could not be loaded.'));
        setInvitationsStatus(nextInvitations.length === 0 ? 'error' : 'partial');
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, reloadKey, workspace.canManageMembers, workspaceId]);

  useEffect(() => {
    if (!workspace.canManageMembers) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setInviteesStatus('loading');
      setInviteesError(null);
    });
    const timer = window.setTimeout(
      () => {
        void (async () => {
          const nextInvitees: WorkspaceInvitee[] = [];
          try {
            for await (const invitee of client.paginate(
              coreWorkspaces.listInvitees(workspaceId, inviteeQuery.trim()),
              {
                signal: controller.signal,
              },
            )) {
              nextInvitees.push(invitee);
            }
            if (controller.signal.aborted) return;
            setInvitees(nextInvitees);
            setInviteesStatus('ready');
          } catch (reason) {
            if (controller.signal.aborted || isCanceledError(reason)) return;
            setInvitees(nextInvitees);
            setInviteesError(problem(reason, 'People available to invite could not be loaded.'));
            setInviteesStatus(nextInvitees.length === 0 ? 'error' : 'partial');
          }
        })();
      },
      inviteeQuery.trim().length === 0 ? 0 : 250,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, inviteeQuery, reloadKey, workspace.canManageMembers, workspaceId]);

  const reload = useCallback(() => {
    setReloadKey((value) => value + 1);
  }, []);

  const mutate = useCallback(
    async (
      action: (signal: AbortSignal) => Promise<unknown>,
      success: string,
    ): Promise<boolean> => {
      const controller = new AbortController();
      mutations.current.add(controller);
      setWorking(true);
      setMutationError(null);
      setMutationNotice(null);
      try {
        await action(controller.signal);
        if (controller.signal.aborted || !mounted.current) return false;
        setMutationNotice(success);
        reload();
        return true;
      } catch (reason) {
        if (controller.signal.aborted || isCanceledError(reason) || !mounted.current) return false;
        setMutationError(problem(reason, 'The workspace change could not be saved.'));
        return false;
      } finally {
        mutations.current.delete(controller);
        if (mounted.current) setWorking(false);
      }
    },
    [reload],
  );

  return {
    membersStatus,
    invitationsStatus,
    inviteesStatus,
    members,
    invitations,
    invitees,
    membersError,
    invitationsError,
    inviteesError,
    mutationError,
    mutationNotice,
    working,
    reload,
    rename: async (name) => {
      let renamed = workspace;
      const saved = await mutate(async (signal) => {
        renamed = await client.execute(coreWorkspaces.renameWorkspace(workspaceId, name), {
          signal,
        });
      }, 'Workspace renamed.');
      if (saved) {
        workspaceUpdated(renamed);
        reloadWorkspaces();
      }
      return saved;
    },
    invite: (principalId, role) => {
      const invitee = invitees.find((candidate) => candidate.principalId === principalId);
      const label = invitee?.displayName ?? 'the selected person';
      return mutate(
        (signal) =>
          client.execute(coreWorkspaces.createInvitation(workspaceId, principalId, role), {
            signal,
          }),
        `${label} was invited. They join when they accept.`,
      );
    },
    revokeInvitation: (invitationId) =>
      mutate(
        (signal) =>
          client.execute(coreWorkspaces.revokeInvitation(workspaceId, invitationId), { signal }),
        'Invitation revoked.',
      ),
    changeRole: (principalId, role) =>
      mutate(
        (signal) =>
          client.execute(coreWorkspaces.changeMemberRole(workspaceId, principalId, role), {
            signal,
          }),
        'Member role changed.',
      ),
    removeMember: (principalId) =>
      mutate(
        (signal) =>
          client.execute(coreWorkspaces.removeMember(workspaceId, principalId), { signal }),
        'Member removed.',
      ),
    leave: async () => {
      const left = await mutate(
        (signal) => client.execute(coreWorkspaces.leaveWorkspace(workspaceId), { signal }),
        'You left the workspace.',
      );
      if (left) reloadWorkspaces();
      return left;
    },
    archive: async () => {
      let archived = workspace;
      const saved = await mutate(async (signal) => {
        archived = await client.execute(coreWorkspaces.archiveWorkspace(workspaceId), { signal });
      }, 'Workspace archived.');
      if (saved) {
        workspaceUpdated(archived);
        reloadWorkspaces();
      }
      return saved;
    },
  };
}
