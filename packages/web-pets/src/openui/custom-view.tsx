import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { ViewRendererProps } from '@nix/web-views/core/view-kinds';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import OpenUiBlock from './openui-block';
import { withContainer } from './starter-program';

export default function CustomView({ container, view }: ViewRendererProps): ReactNode {
  const { workspaceId } = useWorkspace();
  const program = view.program ?? '';
  return (
    <div className="flex min-w-0 flex-col gap-2 p-4">
      {program.trim() === '' ? (
        <Text variant="note">This view has no program yet. Ask your companion to add one.</Text>
      ) : (
        <OpenUiBlock
          key={`${view.id}:${program}`}
          source={withContainer(program, container.itemId)}
          workspaceIds={[workspaceId]}
          stateKey={`view:${container.itemId ?? 'root'}:${view.id}`}
          fallback={
            <Text variant="note" role="alert">
              This view could not render. Ask your companion to fix it.
            </Text>
          }
        />
      )}
    </div>
  );
}
