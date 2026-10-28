import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import type { PreviewModel } from '@nix/structure-spec';
import { Text } from '@nix/ui';
import { lazy, Suspense, type ReactNode } from 'react';

import { AppErrorBoundary } from '@nix/web-foundation/components/error-boundary';
import { programIn } from '../../openui/fence';
import { previewProgram } from '../../openui/preview-program';

// The renderer is its own chunk; a card without a summary never loads it.
const OpenUiBlock = lazy(() => import('../../openui/openui-block'));

/**
 * What an approval card draws with OpenUI, above (never instead of) its full preview: the counts
 * and values Nix computed for this change, and, when a body edit changes a generated-UI program,
 * that program before and after, running. Both render read-only, so nothing in a preview can ask
 * for another write.
 */
export function ApprovalSummary({
  model,
  args,
  workspaceId,
}: {
  readonly model: PreviewModel;
  readonly args: WorkspaceToolArgs;
  readonly workspaceId: string;
}): ReactNode {
  const summary = previewProgram(args);
  const before = model.bodyEdit ? programIn(model.bodyEdit.before) : null;
  const after = model.bodyEdit ? programIn(model.bodyEdit.after) : null;
  if (summary === null && (before === null || after === null)) return null;
  const fallback = (
    <Text variant="note">The summary could not be drawn; the full preview is below.</Text>
  );
  // Contained: a summary that fails to draw must never take the approval card down with it.
  return (
    <AppErrorBoundary>
      <Suspense fallback={null}>
        {summary ? (
          <OpenUiBlock source={summary} workspaceIds={[workspaceId]} fallback={fallback} readOnly />
        ) : null}
        {before !== null && after !== null ? (
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <Text variant="note" tone="muted">
                Now
              </Text>
              <OpenUiBlock
                source={before}
                workspaceIds={[workspaceId]}
                fallback={fallback}
                readOnly
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Text variant="note" tone="muted">
                After this change
              </Text>
              <OpenUiBlock
                source={after}
                workspaceIds={[workspaceId]}
                fallback={fallback}
                readOnly
              />
            </div>
          </div>
        ) : null}
      </Suspense>
    </AppErrorBoundary>
  );
}
