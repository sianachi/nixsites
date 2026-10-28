import { Button, Input, Select, Text } from '@nix/ui';
import { useId, useState, type ReactNode } from 'react';

import { ErrorPanel } from '@nix/web-foundation/components/states/status-panels';
import type { Administration, AssignableRole, CurrentWorkspace } from './shared';

const label = (person: { displayName: string; email: string | null }): string =>
  person.email === null ? person.displayName : `${person.displayName} (${person.email})`;

/**
 * One row: a search box that also picks (a datalist of the people Core says can be invited), a
 * role, and Invite. Typing searches; choosing a suggestion fixes the person without a new search.
 * shortcut: people who cannot be invited are left out of the suggestions rather than listed with
 * a reason, because a datalist cannot disable an option.
 */
export function InviteSection(props: {
  readonly workspace: CurrentWorkspace;
  readonly administration: Administration;
  readonly onInviteeQueryChange: (query: string) => void;
}): ReactNode {
  const { workspace, administration } = props;
  const listId = useId();
  const [text, setText] = useState('');
  const [role, setRole] = useState<AssignableRole>('editor');
  const picked =
    administration.invitees.find((person) => person.canInvite && label(person) === text) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked === null) return;
          void administration.invite(picked.principalId, role).then((saved) => {
            if (!saved) return;
            setText('');
            props.onInviteeQueryChange('');
          });
        }}
      >
        <Input
          type="text"
          list={listId}
          aria-label="Person"
          placeholder="Add person…"
          maxLength={160}
          autoComplete="off"
          className="min-w-0 flex-1 basis-48"
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const match = administration.invitees.some(
              (person) => person.canInvite && label(person) === next,
            );
            if (!match) props.onInviteeQueryChange(next);
          }}
        />
        <datalist id={listId}>
          {administration.invitees
            .filter((person) => person.canInvite)
            .map((person) => (
              <option key={person.principalId} value={label(person)} />
            ))}
        </datalist>
        <Select
          aria-label="Role"
          className="w-auto"
          value={role}
          onChange={(event) => {
            setRole(event.target.value as AssignableRole);
          }}
        >
          {workspace.kind === 'shared' ? <option value="owner">Owner</option> : null}
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </Select>
        <Button type="submit" disabled={administration.working || picked === null}>
          Invite
        </Button>
      </form>
      <Text variant="note" tone="muted">
        People who have signed in to Nix here can be invited. They see nothing in this workspace
        until they accept.
      </Text>
      {administration.inviteesStatus === 'partial' ? (
        <Text role="alert" tone="muted">
          {administration.inviteesError} The list is incomplete; some people may be missing.
        </Text>
      ) : null}
      {administration.inviteesStatus === 'error' ? (
        <ErrorPanel
          title="People could not be loaded"
          detail={administration.inviteesError ?? 'Try again.'}
          action={
            <Button variant="secondary" onClick={administration.reload}>
              Try again
            </Button>
          }
        />
      ) : administration.inviteesStatus === 'ready' &&
        administration.invitees.every((person) => !person.canInvite) ? (
        <Text tone="muted">
          {text.trim().length === 0
            ? 'No people are available. They must sign in to Nix in this organization before they appear here.'
            : 'No people match this search. Try another name or email.'}
        </Text>
      ) : null}
    </div>
  );
}
