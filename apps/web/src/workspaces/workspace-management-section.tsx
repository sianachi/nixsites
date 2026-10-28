import { Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import { DailyNotesSwitch } from '../settings/daily-notes/daily-notes-switch';
import { ConfirmationDialog } from './settings/confirmation-dialog';
import { CreateWorkspaceForm } from './settings/create-workspace-form';
import { InvitationsList } from './settings/invitations-list';
import { InviteSection } from './settings/invite-section';
import { LeaveArchiveSection } from './settings/leave-archive-section';
import { MembersList } from './settings/members-list';
import { RenameForm } from './settings/rename-form';
import type { Confirmation } from './settings/shared';
import { SharingSwitches } from './settings/sharing-switches';
import { WorkspaceOverview } from './settings/workspace-overview';
import { useWorkspace } from './workspace-context';
import { useWorkspaceAdministration } from './use-workspace-administration';
import { WorkspaceGroupsSection } from './workspace-groups-section';

export function WorkspaceManagementSection(): ReactNode {
  const { workspace } = useWorkspace();
  const [inviteeQuery, setInviteeQuery] = useState('');
  const administration = useWorkspaceAdministration(inviteeQuery);
  const [creating, setCreating] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  return (
    <section
      aria-labelledby="workspace-management-heading"
      aria-busy={administration.working || creating}
      className="flex min-w-0 max-w-4xl flex-col gap-6"
    >
      <WorkspaceOverview workspace={workspace} />

      <WorkspaceGroupsSection />

      {administration.mutationError === null ? null : (
        <Text role="alert" tone="muted">
          {administration.mutationError}
        </Text>
      )}
      <div aria-live="polite" aria-atomic="true">
        {administration.working ? (
          <Text tone="muted">Saving workspace changes…</Text>
        ) : administration.mutationNotice === null ? null : (
          <Text>{administration.mutationNotice}</Text>
        )}
      </div>

      {workspace.canRename ? (
        <RenameForm workspace={workspace} administration={administration} />
      ) : null}

      <DailyNotesSwitch />

      <SharingSwitches />

      <CreateWorkspaceForm onBusyChange={setCreating} />

      {!workspace.canManageMembers ? (
        <Text tone="muted">You can see this workspace, but you cannot manage its members.</Text>
      ) : (
        <>
          {administration.membersStatus === 'error' ||
          administration.membersStatus === 'partial' ||
          administration.invitationsStatus === 'error' ||
          administration.invitationsStatus === 'partial' ||
          administration.inviteesStatus === 'error' ||
          administration.inviteesStatus === 'partial' ? (
            <PartialNotice pending="Some workspace access information is unavailable. The available section remains usable." />
          ) : null}
          {workspace.membershipLocked ? (
            <Text tone="muted">
              This workspace is closed to new members. Allow new members above to invite someone.
            </Text>
          ) : (
            <InviteSection
              workspace={workspace}
              administration={administration}
              inviteeQuery={inviteeQuery}
              onInviteeQueryChange={setInviteeQuery}
            />
          )}
          <MembersList administration={administration} onConfirm={setConfirmation} />
          <InvitationsList administration={administration} />
        </>
      )}

      <LeaveArchiveSection
        workspace={workspace}
        administration={administration}
        onConfirm={setConfirmation}
      />

      <ConfirmationDialog
        confirmation={confirmation}
        administration={administration}
        onClose={() => {
          setConfirmation(null);
        }}
      />
    </section>
  );
}
