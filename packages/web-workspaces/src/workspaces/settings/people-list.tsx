import { Button, Select, Tag, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { ErrorPanel, LoadingPanel } from '@nix/web-foundation/components/states/status-panels';
import type { Administration, AssignableRole, Confirmation } from './shared';

const ROW = 'flex flex-wrap items-center gap-2 py-1.5';

/** Members, then pending invitations marked "Invited"; accepted and revoked ones are history. */
export function PeopleList(props: {
  readonly administration: Administration;
  readonly onConfirm: (confirmation: Confirmation) => void;
}): ReactNode {
  const { administration } = props;
  const pending = administration.invitations.filter(
    (invitation) => invitation.status === 'pending',
  );
  const retry = (
    <Button variant="secondary" onClick={administration.reload}>
      Try again
    </Button>
  );
  return (
    <div className="flex flex-col gap-2">
      {administration.membersStatus === 'loading' ? (
        <LoadingPanel label="workspace members" />
      ) : administration.membersStatus === 'error' ? (
        <ErrorPanel
          title="Members could not be loaded"
          detail={administration.membersError ?? 'Try again.'}
          action={retry}
        />
      ) : administration.membersStatus === 'partial' && administration.members.length === 0 ? (
        <ErrorPanel
          title="Member access could not be checked"
          detail={administration.membersError ?? 'Some member information is unavailable.'}
          action={retry}
        />
      ) : null}
      {administration.invitationsStatus === 'error' ? (
        <ErrorPanel
          title="Invitations could not be loaded"
          detail={administration.invitationsError ?? 'Try again.'}
          action={retry}
        />
      ) : administration.invitationsStatus === 'partial' && pending.length === 0 ? (
        <ErrorPanel
          title="Invitations could not be checked"
          detail={administration.invitationsError ?? 'Some invitation information is unavailable.'}
          action={retry}
        />
      ) : null}
      <ul aria-label="People" className="flex flex-col divide-y divide-divider">
        {administration.members.map((member) => (
          <li key={`${member.subjectType}:${member.subjectId}`} className={ROW}>
            <Text className="min-w-0 flex-1 basis-40 break-words">{member.subjectDisplayName}</Text>
            <Select
              aria-label={`Role for ${member.subjectDisplayName}`}
              value={member.role}
              disabled={!member.canChangeRole || administration.working}
              onChange={(event) =>
                void administration.changeRole(
                  member.subjectId,
                  event.target.value as AssignableRole,
                )
              }
              className="w-auto"
            >
              {member.assignableRoles.includes('owner') || member.role === 'owner' ? (
                <option value="owner" disabled={!member.assignableRoles.includes('owner')}>
                  Owner
                </option>
              ) : null}
              {member.role === 'commenter' ? (
                <option value="commenter" disabled>
                  Commenter (legacy)
                </option>
              ) : null}
              {member.assignableRoles.includes('editor') || member.role === 'editor' ? (
                <option value="editor" disabled={!member.assignableRoles.includes('editor')}>
                  Editor
                </option>
              ) : null}
              {member.assignableRoles.includes('viewer') || member.role === 'viewer' ? (
                <option value="viewer" disabled={!member.assignableRoles.includes('viewer')}>
                  Viewer
                </option>
              ) : null}
            </Select>
            {member.canRemove ? (
              <Button
                variant="secondary"
                aria-label={`Remove ${member.subjectDisplayName}`}
                disabled={administration.working}
                onClick={() => {
                  props.onConfirm({
                    kind: 'remove',
                    principalId: member.subjectId,
                    name: member.subjectDisplayName,
                  });
                }}
              >
                Remove
              </Button>
            ) : null}
          </li>
        ))}
        {pending.map((invitation) => (
          <li key={invitation.id} className={ROW}>
            <Text className="min-w-0 flex-1 basis-40 break-all">{invitation.emailNormalized}</Text>
            <Tag tone="muted">Invited</Tag>
            <Text tone="muted" className="capitalize">
              {invitation.role}
            </Text>
            <Button
              variant="secondary"
              aria-label={`Revoke invitation for ${invitation.emailNormalized}`}
              disabled={administration.working}
              onClick={() => void administration.revokeInvitation(invitation.id)}
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
