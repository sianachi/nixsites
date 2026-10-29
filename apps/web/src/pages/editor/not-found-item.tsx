import { Button, Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { PaneState } from '@nix/web-platform/panes/pane-state';
import type { ShellContext } from '../../shell/shell-context';
import { useForgetMissingSmartList } from '@nix/web-views/query/known-smart-lists';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';

interface NotFoundItemProps {
  readonly tree: ShellContext['tree'];
  readonly pane: PaneState;
  readonly onClose: (() => void) | undefined;
}

/**
 * Four different things, said differently. The tree loads roots and then children on expansion,
 * so anything nested is absent until a reveal walks up to it - and that walk is several requests,
 * during which "not in this workspace" is simply untrue. It is also the wrong sentence for an
 * item somebody may not read, which is theirs to ask about rather than absent, and the wrong
 * sentence again when it is the tree itself that failed.
 */
export function NotFoundItem({ tree, pane, onClose }: NotFoundItemProps): ReactNode {
  const reveal = tree.revealOf(pane.itemId);
  // A smart list that cannot be found is dropped from the rail's list rather than offered again.
  useForgetMissingSmartList(
    useOptionalWorkspace()?.workspaceId ?? null,
    pane.itemId,
    reveal === 'missing',
  );
  const waiting = tree.status === 'loading' || reveal === null || reveal === 'revealing';
  const failed = reveal === 'failed' || tree.status === 'error';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Text variant="note" tone="muted" className="max-w-sm">
        {waiting
          ? 'Finding this item…'
          : failed
            ? 'Something went wrong finding this item.'
            : reveal === 'forbidden'
              ? "You can't view this item."
              : 'We cannot find that item. It may have been deleted.'}
      </Text>

      {/* Without these a bad link is a dead end: the pane shows a sentence and offers nothing,
          and in a single-pane arrangement there is no other control on the screen at all. A
          failure is the one outcome worth another go, so it gets a way to take it. */}
      <div className="flex items-center gap-2">
        {failed ? (
          <Button
            variant="secondary"
            onClick={() => {
              void tree.retryReveal(pane.itemId);
            }}
          >
            Try again
          </Button>
        ) : null}

        {waiting || onClose === undefined ? null : (
          <Button variant="ghost" onClick={onClose}>
            Close this pane
          </Button>
        )}
      </div>
    </div>
  );
}
