import { Blueprint, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { paneScroller } from '@nix/web-foundation/layout/regions';
import { WorkspacesPanel } from '@nix/web-workspaces/workspaces/workspace-switcher';
import { useInRouteDialog } from '@nix/web-foundation/layout/route-dialog-context';

/** Every workspace the person can reach, as a page: the switcher panel with room to breathe. */
export function WorkspacesPage(): ReactNode {
  const inDialog = useInRouteDialog();
  return (
    <div
      className={`${paneScroller} mx-auto flex w-full max-w-2xl md:max-w-4xl flex-col gap-4 ${inDialog ? '' : 'p-3 sm:p-6'}`}
    >
      {inDialog ? null : (
        <Text variant="h3" as="h1">
          Workspaces
        </Text>
      )}
      <Blueprint>
        <WorkspacesPanel />
      </Blueprint>
    </div>
  );
}
