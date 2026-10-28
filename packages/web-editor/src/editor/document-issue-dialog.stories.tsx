import type { ReactElement } from 'react';
import { Text } from '@nix/ui';
import { DocumentIssueDialog } from './document-issue-dialog';

export default { title: 'Nix/Editor/Document issues', parameters: { layout: 'padded' } };

export const Offline = {
  render: (): ReactElement => (
    <>
      <Text variant="h1">Weekly notes</Text>
      <DocumentIssueDialog noun="note" state="offline" draftState="local" />
    </>
  ),
};
export const DarkOffline = { ...Offline, globals: { ground: 'dark' } };
export const StaleCopy = {
  render: (): ReactElement => (
    <>
      <Text variant="h1">Weekly notes</Text>
      <DocumentIssueDialog noun="note" state="degraded" stale />
    </>
  ),
};
export const MultipleFailures = {
  render: (): ReactElement => (
    <>
      <Text variant="h1">Weekly notes</Text>
      <DocumentIssueDialog noun="note" state="offline" draftState="error" />
      <DocumentIssueDialog
        noun="sheet"
        state="offline"
        refusal="This sheet has reached its size limit. Remove some cells before adding more."
      />
    </>
  ),
};
