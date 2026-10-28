import type { ReactNode } from 'react';

import { paneClip, paneColumn } from '@nix/web-foundation/layout/regions';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useZenActive } from '@nix/web-foundation/lib/zen-mode';
import { paneElementId } from '@nix/web-platform/panes/pane-params';
import type { PaneState } from '@nix/web-platform/panes/pane-state';
import type { ShellContext } from '../../shell/shell-context';
import { DocumentTabStrip } from '../../tabs/document-tab-strip';
import { useTabOrientationStore } from '../../tabs/tab-orientation-store';
import type { TabTransferPayload } from '../../tabs/tab-transfer';
import { useTabStore } from '@nix/web-foundation/lib/tab-store';
import { useOpenItem } from '../../tabs/use-open-item';
import { Text } from '@nix/ui';
import { useWorkspace } from '../../workspaces/workspace-context';
import { PetConversationPane } from '../pet-page';
import { NotFoundItem } from './not-found-item';
import { OpenItem } from './open-item';

interface PaneContentsProps {
  readonly pane: PaneState;
  readonly tree: ShellContext['tree'];
  readonly visiblePanes: readonly PaneState[];
  readonly draggedTab: TabTransferPayload | null;
  readonly onTabDragStarted: (payload: TabTransferPayload) => void;
  readonly onTabDragEnded: () => void;
  readonly onMoveTab: (
    payload: TabTransferPayload,
    destinationPane: number,
    title: string,
  ) => boolean;

  /** How many panes this address holds that this window is too narrow to draw. */
  readonly hiddenPanes: number;
  readonly canManageTemplates: boolean;
  readonly canApplyTemplates: boolean;
  readonly onClose: (() => void) | undefined;
  readonly paneLabel: string | undefined;

  /** Told whenever focus enters this pane, so Zen knows which one to keep. */
  readonly onFocused: (index: number) => void;
}

/**
 * One pane's item, resolved.
 *
 * Split out of `EditorPage` because it has to run inside `PaneProvider` - `useOpenItem` reads the
 * pane from context (by way of `usePaneIndex`), and a component that called it above the provider
 * would be reading the first pane's parameters no matter which pane it was drawing.
 *
 * Breadcrumbs and in-document links open through `useOpenItem` rather than a bare
 * `useSelectedItem().select`, the same as a sidebar click - a link inside pane 2 to a document
 * that is already open, backgrounded, in pane 1 has to focus it there, not open a second copy.
 */
export function PaneContents({
  pane,
  tree,
  visiblePanes,
  draggedTab,
  onTabDragStarted,
  onTabDragEnded,
  onMoveTab,
  onClose,
  paneLabel,
  onFocused,
  hiddenPanes,
  canManageTemplates,
  canApplyTemplates,
}: PaneContentsProps): ReactNode {
  const { openPreview, openPinned, openBeside } = useOpenItem();
  const tabPinned = useTabStore((state) => state.tabPinned);
  const narrow = useNarrowViewport();
  const orientation = useTabOrientationStore((state) => state.orientation);
  const item = tree.find(pane.itemId);
  const zen = useZenActive();
  const { workspaceId } = useWorkspace();

  return (
    <article
      id={paneElementId(pane.index)}
      // Focusable only programmatically: a pane is a landmark to be sent to, not a stop on the way
      // through. Without it, closing a pane drops focus to the document body and a keyboard user
      // has to Tab through the tree and a whole editor to get back to where they were.
      tabIndex={-1}
      aria-label={paneLabel}
      onFocus={() => {
        onFocused(pane.index);
      }}
      className={paneColumn}
    >
      {/* A row when tabs are vertical, so the rail sits beside the rest of the pane rather than
          above it; a column otherwise, which is the arrangement this always was. Orientation is
          one preference for every pane (`tab-orientation-store.ts`), read here rather than
          threaded down, because this is the one place that has to lay the pane out around it. */}
      <div
        className={`flex flex-1 ${paneClip} ${orientation === 'vertical' ? 'flex-row' : 'flex-col'}`}
      >
        {/* Mounted here rather than inside `OpenItem`, and above the not-found branch below: an
            item resolving, forbidden, or failed must not take the rest of the strip down with it,
            or a person could not click back to a tab that is perfectly fine. */}
        {!narrow && !zen ? (
          <DocumentTabStrip
            paneIndex={pane.index}
            tree={tree}
            activeItemId={pane.itemId}
            activeChat={pane.chat}
            visiblePanes={visiblePanes}
            draggedTab={draggedTab}
            onTabDragStarted={onTabDragStarted}
            onTabDragEnded={onTabDragEnded}
            onMoveTab={onMoveTab}
            onClosePane={onClose}
          />
        ) : null}

        <div className={paneColumn}>
          {hiddenPanes > 0 && !zen ? (
            <Text variant="caption" as="p" tone="muted" className="shrink-0 px-8 pb-1 pt-1">
              {hiddenPanes === 1
                ? 'One more pane in this link opens on a wider screen.'
                : `${String(hiddenPanes)} more panes in this link open on a wider screen.`}
            </Text>
          ) : null}

          {pane.chat !== undefined ? (
            // Keyed on the scope: workspace chat and a note's chat are different conversations,
            // each with its own runtime.
            <PetConversationPane
              key={pane.chat}
              workspaceId={workspaceId}
              rootItemId={pane.chat === 'workspace' ? null : pane.chat}
            />
          ) : item === null ? (
            <NotFoundItem tree={tree} pane={pane} onClose={onClose} />
          ) : (
            // Keyed on the item throughout: switching notes has to build a new Yjs document and
            // a new title draft rather than reuse one, which is the failure that would otherwise
            // carry one note's text into another.
            <OpenItem
              key={item.id}
              tree={tree}
              itemId={item.id}
              title={item.title}
              bodyKind={item.type}
              canManageTemplates={canManageTemplates}
              canApplyTemplates={canApplyTemplates}
              onOpen={openPreview}
              onOpenBeside={(target) => {
                openBeside(target);
              }}
              onOpenPinned={openPinned}
              onClose={onClose}
              onCommit={() => {
                tabPinned(pane.index, item.id);
              }}
            />
          )}
        </div>
      </div>
    </article>
  );
}
