import { Blueprint, Button, Field, Input, Select, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { ErrorPanel, LoadingPanel } from '../../components/states/status-panels';
import {
  invitationReason,
  type Administration,
  type AssignableRole,
  type CurrentWorkspace,
} from './shared';

export function InviteSection(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
  readonly inviteeQuery: string;
  readonly onInviteeQueryChange: (query: string) => void;
}): ReactNode {
  const { workspace, administration, inviteeQuery } = props;
  const [inviteePrincipalId, setInviteePrincipalId] = useState('');
  const [role, setRole] = useState<AssignableRole>('editor');

  return (
    <Blueprint className="flex flex-col gap-3 p-4">
      <Text variant="h4" as="h3">
        Invite someone
      </Text>
      <Text variant="note" tone="muted">
        People who have signed in to Nix here can be invited.
      </Text>
      <details>
        <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
          More<span className="sr-only"> about invitations</span>
        </summary>
        <Text variant="note" tone="muted">
          People with a verified email who do not already have access can be invited. They are
          notified, and see nothing in this workspace until they accept.
        </Text>
      </details>
      <Field label="Search people by name or email">
        {(control) => (
          <Input
            {...control}
            type="search"
            maxLength={128}
            value={inviteeQuery}
            onChange={(event) => {
              props.onInviteeQueryChange(event.target.value);
              setInviteePrincipalId('');
            }}
          />
        )}
      </Field>
      {administration.inviteesStatus === 'partial' ? (
        <Text role="alert" tone="muted">
          {administration.inviteesError} The list is incomplete; some people may be missing.
        </Text>
      ) : null}
      <Button variant="secondary" onClick={administration.reload} disabled={administration.working}>
        Refresh people
      </Button>
      {administration.inviteesStatus === 'loading' ? (
        <LoadingPanel label="people available to invite" />
      ) : administration.inviteesStatus === 'error' ? (
        <ErrorPanel
          title="People could not be loaded"
          detail={administration.inviteesError ?? 'Try again.'}
          action={
            <Button variant="secondary" onClick={administration.reload}>
              Try again
            </Button>
          }
        />
      ) : administration.inviteesStatus === 'partial' && administration.invitees.length === 0 ? (
        <ErrorPanel
          title="Available people could not be checked"
          detail={administration.inviteesError ?? 'Some people may be unavailable.'}
          action={
            <Button variant="secondary" onClick={administration.reload}>
              Try again
            </Button>
          }
        />
      ) : (
        <>
          <form
            className="grid min-w-0 gap-2 lg:grid-cols-[minmax(0,1fr)_12rem_auto] lg:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void administration.invite(inviteePrincipalId, role).then((saved) => {
                if (saved) setInviteePrincipalId('');
              });
            }}
          >
            <Field label="Person" className="min-w-0">
              {(control) => (
                <Select
                  {...control}
                  required
                  disabled={administration.invitees.length === 0}
                  value={inviteePrincipalId}
                  onChange={(event) => {
                    setInviteePrincipalId(event.target.value);
                  }}
                >
                  <option value="" disabled>
                    {administration.invitees.length === 0
                      ? 'No people available to invite'
                      : 'Select a person'}
                  </option>
                  {administration.invitees.map((invitee) => (
                    <option
                      key={invitee.principalId}
                      value={invitee.principalId}
                      disabled={!invitee.canInvite}
                    >
                      {invitee.displayName}
                      {invitee.email === null ? '' : ` (${invitee.email})`}
                      {invitee.canInvite
                        ? ''
                        : ` — ${invitationReason(invitee.cannotInviteReason)}`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Role" className="min-w-0">
              {(control) => (
                <Select
                  {...control}
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value as AssignableRole);
                  }}
                >
                  {workspace.kind === 'shared' ? <option value="owner">Owner</option> : null}
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </Select>
              )}
            </Field>
            <Button
              type="submit"
              disabled={
                administration.working ||
                !administration.invitees.some(
                  (person) => person.principalId === inviteePrincipalId && person.canInvite,
                )
              }
            >
              Invite
            </Button>
          </form>
          {administration.invitees.length === 0 ? (
            <Text tone="muted">
              {inviteeQuery.trim().length === 0
                ? 'No people are available. They must sign in to Nix in this organization before they appear here.'
                : 'No people match this search. Try another name or email, or clear the search.'}
            </Text>
          ) : null}
        </>
      )}
    </Blueprint>
  );
}
