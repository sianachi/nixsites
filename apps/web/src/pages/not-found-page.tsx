import type { ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { EmptyPanel } from '@nix/web-foundation/components/states/status-panels';
import { paneScroller } from '@nix/web-foundation/layout/regions';

import { Button } from '@nix/ui';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

export function NotFoundPage(): ReactElement {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();

  return (
    <div className={`${paneScroller} break-words p-3 sm:p-4`}>
      <EmptyPanel
        title="Page not found"
        detail="This link may be out of date. Return to the workspace to find your work."
        action={
          <Button
            variant="secondary"
            onClick={() => {
              void navigate(`/w/${workspaceId}`);
            }}
          >
            Back to workspace
          </Button>
        }
      />
    </div>
  );
}
