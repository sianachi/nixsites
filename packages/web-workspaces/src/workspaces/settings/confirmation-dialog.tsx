import { Button, Dialog, Text } from '@nix/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useWorkspace } from '../workspace-context';
import type { Administration, Confirmation } from './shared';

export function ConfirmationDialog(props: {
  readonly confirmation: Confirmation;
  readonly administration: Administration;
  readonly onClose: () => void;
}): ReactNode {
  const { confirmation, administration, onClose } = props;
  const navigate = useNavigate();
  const context = useWorkspace();
  const { workspace } = context;

  return (
    <Dialog
      open={confirmation !== null}
      title={
        confirmation?.kind === 'remove'
          ? `Remove ${confirmation.name}?`
          : confirmation?.kind === 'archive'
            ? 'Archive workspace?'
            : 'Leave workspace?'
      }
      onClose={() => {
        if (!administration.working) onClose();
      }}
      actions={
        <>
          <Button variant="secondary" disabled={administration.working} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={administration.working}
            onClick={() => {
              if (confirmation?.kind === 'remove') {
                void administration.removeMember(confirmation.principalId).then((removed) => {
                  if (removed) onClose();
                });
                return;
              }
              if (confirmation?.kind === 'leave') {
                void administration.leave().then((left) => {
                  if (!left) return;
                  context.workspaceRemoved(workspace.id);
                  onClose();
                  void navigate('/');
                });
                return;
              }
              if (confirmation?.kind === 'archive') {
                void administration.archive().then((archived) => {
                  if (!archived) return;
                  onClose();
                  void navigate('/workspaces/archived');
                });
              }
            }}
          >
            {confirmation?.kind === 'remove'
              ? 'Remove member'
              : confirmation?.kind === 'archive'
                ? 'Archive workspace'
                : 'Leave workspace'}
          </Button>
        </>
      }
    >
      <Text>
        {confirmation?.kind === 'remove'
          ? `${confirmation.name} will lose access to this workspace.`
          : confirmation?.kind === 'archive'
            ? `${workspace.name} will be hidden from everyday navigation. You can restore it from Archived workspaces.`
            : `You will lose access to ${workspace.name}.`}
      </Text>
    </Dialog>
  );
}
