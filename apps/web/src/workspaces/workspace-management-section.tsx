import { Text } from '@nix/ui';
import { useEffect, useState, type ReactNode } from 'react';

import { PartialNotice } from '../components/states/status-panels';
import { publishNotice } from '../lib/notices';
import { DailyNotesSwitch } from '../settings/daily-notes/daily-notes-switch';
import { ConfirmationDialog } from './settings/confirmation-dialog';
import { InviteSection } from './settings/invite-section';
import { PeopleList } from './settings/people-list';
import type { Confirmation } from './settings/shared';
import { SharingSwitches } from './settings/sharing-switches';
import { WorkspaceOverview } from './settings/workspace-overview';
import { useWorkspace } from './workspace-context';
import { useWorkspaceAdministration } from './use-workspace-administration';

export function WorkspaceManagementSection(): ReactNode {
  const { workspace } = useWorkspace();
  const [inviteeQuery, setInviteeQuery] = useState('');
  const administration = useWorkspaceAdministration(inviteeQuery);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const { mutationNotice, mutationError } = administration;

  // Saves and refusals are said once, by the shell's toasts, not kept in the page.
  useEffect(() => {
    if (mutationNotice !== null) publishNotice({ key: 'workspace-saved', message: mutationNotice });
  }, [mutationNotice]);
  useEffect(() => {
    if (mutationError !== null) publishNotice({ key: 'workspace-refused', message: mutationError });
  }, [mutationError]);

  return (
    <section
      aria-labelledby="workspace-management-heading"
      aria-busy={administration.working}
      className="flex min-w-0 max-w-3xl flex-col gap-6"
    >
      <WorkspaceOverview
        workspace={workspace}
        administration={administration}
        onConfirm={setConfirmation}
      />

      <section aria-labelledby="workspace-options-heading" className="flex flex-col gap-1">
        <Text id="workspace-options-heading" variant="h4" as="h3">
          Options
        </Text>
        <DailyNotesSwitch />
        <SharingSwitches />
        {workspace.canRename ? null : (
          <Text variant="note">Only a workspace owner or an administrator can change these.</Text>
        )}
      </section>

      {!workspace.canManageMembers ? (
        <Text tone="muted">You can see this workspace, but you cannot manage its members.</Text>
      ) : (
        <section aria-labelledby="workspace-people-heading" className="flex flex-col gap-2">
          <Text id="workspace-people-heading" variant="h4" as="h3">
            People
          </Text>
          {administration.membersStatus === 'error' ||
          administration.membersStatus === 'partial' ||
          administration.invitationsStatus === 'error' ||
          administration.invitationsStatus === 'partial' ||
          administration.inviteesStatus === 'error' ||
          administration.inviteesStatus === 'partial' ? (
            <PartialNotice pending="Some workspace access information is unavailable. The available section remains usable." />
          ) : null}
          {workspace.membershipLocked ? (
            <Text tone="muted">Closed to new members</Text>
          ) : (
            <InviteSection
              workspace={workspace}
              administration={administration}
              onInviteeQueryChange={setInviteeQuery}
            />
          )}
          <PeopleList administration={administration} onConfirm={setConfirmation} />
        </section>
      )}

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
