import { Button, Dialog, Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { OpenItem } from '../pages/editor-page';
import { PaneProvider } from '@nix/web-platform/panes/pane-context';
import { useOpenItem } from '../tabs/use-open-item';
import { useTemplateLibrary } from '../templates/template-library-context';
import { LocalViewStateContext } from '@nix/web-collections/core/view-state';
import type { WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { ItemDialogContext } from '@nix/web-foundation/lib/item-dialog-context';

export function ItemDialogProvider({
  tree,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly children: ReactNode;
}): ReactNode {
  const location = useLocation();
  return (
    <ItemDialogSession key={location.pathname} tree={tree}>
      {children}
    </ItemDialogSession>
  );
}

function ItemDialogSession({
  tree,
  children,
}: {
  readonly tree: WorkspaceTree;
  readonly children: ReactNode;
}): ReactNode {
  const [stack, setStack] = useState<string[]>([]);
  const { openPreview } = useOpenItem();
  function open(itemId: string): void {
    setStack((current) =>
      current.includes(itemId)
        ? current.slice(0, current.indexOf(itemId) + 1)
        : [...current, itemId],
    );
    void tree.reveal(itemId);
  }
  return (
    <ItemDialogContext value={open}>
      {children}
      {stack.map((itemId, index) => (
        <ItemDialog
          key={itemId}
          itemId={itemId}
          tree={tree}
          onClose={() => {
            setStack((current) => current.slice(0, index));
          }}
          onOpen={open}
          onNavigateAway={() => {
            setStack([]);
          }}
          onPage={() => {
            setStack([]);
            openPreview(itemId);
          }}
        />
      ))}
    </ItemDialogContext>
  );
}

function ItemDialog({
  itemId,
  tree,
  onClose,
  onOpen,
  onPage,
  onNavigateAway,
}: {
  readonly itemId: string;
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
  readonly onOpen: (itemId: string) => void;
  readonly onPage: () => void;
  readonly onNavigateAway: () => void;
}): ReactNode {
  const [params, setParams] = useState(() => new URLSearchParams());
  const templates = useTemplateLibrary();
  const item = tree.find(itemId);
  const reveal = tree.revealOf(itemId);
  return (
    <Dialog
      open
      title={item !== null && item.title.length > 0 ? item.title : 'Item'}
      onClose={onClose}
      closeLabel="Close item"
      presentation="workspace"
      titleHidden
      actions={
        <Button variant="secondary" onClick={onPage}>
          Open as page
        </Button>
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {item === null ? (
          <div className="p-6">
            <Text as="p">
              {reveal === 'failed'
                ? 'This item could not be loaded.'
                : reveal === 'forbidden'
                  ? "You can't view this item."
                  : reveal === 'missing'
                    ? 'This item is unavailable.'
                    : 'Loading item…'}
            </Text>
            {reveal === 'failed' ? (
              <Button
                onClick={() => {
                  void tree.retryReveal(itemId);
                }}
              >
                Try again
              </Button>
            ) : null}
          </div>
        ) : (
          <PaneProvider index={0}>
            <LocalViewStateContext value={{ params, setParams }}>
              <OpenItem
                tree={tree}
                itemId={item.id}
                title={item.title}
                bodyKind={item.type}
                canManageTemplates={templates.capabilities.canManage}
                canApplyTemplates={templates.templates.some(
                  (template) => template.capabilities.canApply,
                )}
                onOpen={onOpen}
                onClose={undefined}
                onNavigateAway={onNavigateAway}
                onCommit={() => undefined}
              />
            </LocalViewStateContext>
          </PaneProvider>
        )}
      </div>
    </Dialog>
  );
}
