import { treeChildrenEntry } from '../collections/items/item-menu-entries';
import { Button, ContextMenu, Icon, Menu, Text, type MenuEntry } from '@nix/ui';
import { ArrowLeft, ChevronRight, EyeOff, MoreHorizontal, Shapes, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { PaneViewport } from '@nix/web-foundation/layout/pane-viewport';
import { useHiddenItems } from '../collections/items/use-hidden-items';
import { HiddenItemsPanel } from './hidden-items-panel';
import type { WorkspaceTree } from '../collections/items/use-workspace-tree';
import { useItemLandmarks } from './use-item-landmarks';
import { ItemLandmarkDialog, ItemLandmarkIcon } from './item-landmark-dialog';

export function MobileWorkspaceBrowser({
  tree,
  parentId,
  onParent,
  onOpen,
  onClose,
  destinations,
}: {
  readonly tree: WorkspaceTree;
  readonly parentId: string | null;
  readonly onParent: (id: string | null) => void;
  readonly onOpen: (id: string) => void;
  readonly onClose: () => void;
  readonly destinations: ReactNode;
}): ReactNode {
  const visibility = useHiddenItems();
  const treeChildren = useHiddenItems('tree-children');
  const landmarks = useItemLandmarks();
  const iconReturnFocus = useRef<HTMLButtonElement | null>(null);
  const [iconItem, setIconItem] = useState<{
    readonly scope: string | null;
    readonly id: string;
    readonly title: string;
  } | null>(null);
  const visible =
    parentId !== null && treeChildren.hiddenSet.has(parentId)
      ? []
      : tree.childrenOf(parentId).filter((item) => !visibility.hiddenSet.has(item.id));
  const parent = parentId === null ? null : tree.find(parentId);
  const loading =
    tree.status === 'loading' || (parentId !== null && tree.isLoadingChildren(parentId));
  return (
    <aside aria-label="Explorer" className="flex min-h-0 min-w-0 w-full flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-divider px-3 py-2">
        {parentId !== null ? (
          <Button
            variant="ghost"
            className="min-w-0 flex-1 justify-start"
            aria-label="Up"
            onClick={() => {
              onParent(parent?.parentId ?? null);
            }}
          >
            <Icon icon={ArrowLeft} size="sm" />
            <span className="min-w-0 truncate">{parent?.title ?? 'Up'}</span>
          </Button>
        ) : (
          <Text variant="h3" as="h2">
            Explorer
          </Text>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <HiddenItemsPanel onOpen={onOpen} />
          <Button
            variant="ghost"
            className="min-h-(--control-lg) min-w-(--control-lg) px-2"
            aria-label="Close Explorer"
            onClick={onClose}
          >
            <Icon icon={X} size="sm" />
          </Button>
        </div>
      </div>
      <div className="shrink-0 border-b border-divider px-3 py-2">{destinations}</div>
      {parent ? (
        <Button
          variant="ghost"
          className="justify-start px-3"
          onClick={() => {
            onOpen(parent.id);
          }}
        >
          Open {parent.title || 'Untitled'}
        </Button>
      ) : null}
      {loading ? (
        <Text variant="note" role="status" className="p-3">
          Loading items…
        </Text>
      ) : null}
      {tree.error ? (
        <div className="p-3">
          <Text variant="note" role="alert">
            {tree.error}
          </Text>
          <Button
            variant="ghost"
            onClick={() => {
              if (parentId) void tree.expand(parentId);
              else void tree.reload();
            }}
          >
            Try again
          </Button>
        </div>
      ) : null}
      <PaneViewport
        scrollKey={`mobile-workspace:${parentId ?? 'root'}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      >
        {visible.map((item) => {
          const actions: MenuEntry[] = [
            treeChildrenEntry(treeChildren, item.id, item.title),
            ...(landmarks.enabled
              ? [
                  {
                    kind: 'action' as const,
                    label: 'Choose icon…',
                    icon: Shapes,
                    onSelect: () => {
                      setIconItem({
                        scope: landmarks.scope,
                        id: item.id,
                        title: item.title || 'Untitled',
                      });
                    },
                  },
                ]
              : []),
            {
              kind: 'action',
              label: 'Hide for me',
              icon: EyeOff,
              onSelect: () => {
                visibility.hide(item.id, item.title);
              },
            },
          ];
          return (
            <div key={item.id} className="flex min-w-0 items-center gap-1 rounded-md">
              <ContextMenu
                label={`Actions for ${item.title || 'Untitled'}`}
                items={[
                  {
                    label: 'Open',
                    onSelect: () => {
                      onOpen(item.id);
                    },
                  },
                  ...actions,
                ]}
              >
                {(target) => (
                  <Button
                    {...target}
                    variant="ghost"
                    className="min-h-(--control-lg) min-w-0 flex-1 justify-start text-left"
                    onClick={() => {
                      onOpen(item.id);
                    }}
                  >
                    <ItemLandmarkIcon landmark={landmarks.landmarks[item.id]} />
                    <Text as="span" variant="bodySmall" className="min-w-0 truncate">
                      {item.title || 'Untitled'}
                    </Text>
                  </Button>
                )}
              </ContextMenu>
              <Menu label={`Actions for ${item.title || 'Untitled'}`} items={actions}>
                {(trigger) => (
                  <Button
                    {...trigger}
                    onClick={() => {
                      iconReturnFocus.current = trigger.ref.current;
                      trigger.onClick();
                    }}
                    onKeyDown={(event) => {
                      iconReturnFocus.current = trigger.ref.current;
                      trigger.onKeyDown(event);
                    }}
                    variant="ghost"
                    className="min-h-(--control-lg) min-w-(--control-lg) shrink-0 px-2"
                    aria-label={`Actions for ${item.title || 'Untitled'}`}
                  >
                    <Icon icon={MoreHorizontal} size="sm" />
                  </Button>
                )}
              </Menu>
              {item.hasChildren && !treeChildren.hiddenSet.has(item.id) ? (
                <Button
                  variant="ghost"
                  className="min-h-(--control-lg) min-w-(--control-lg)"
                  aria-label={`Browse children of ${item.title || 'Untitled'}`}
                  onClick={() => {
                    onParent(item.id);
                    void tree.expand(item.id);
                  }}
                >
                  <Icon icon={ChevronRight} size="sm" />
                </Button>
              ) : null}
            </div>
          );
        })}
        {!loading && !tree.error && visible.length === 0 ? (
          <Text as="p" variant="note" tone="muted" className="p-3">
            {parentId !== null && treeChildren.hiddenSet.has(parentId)
              ? 'Children are hidden from the tree. Open this item to see them in its views.'
              : tree.childrenOf(parentId).length > 0
                ? 'Items here are hidden for you.'
                : 'No items here yet. Use New note to create one.'}
          </Text>
        ) : null}
      </PaneViewport>
      {iconItem?.scope !== landmarks.scope ? null : (
        <ItemLandmarkDialog
          key={`${landmarks.scope ?? ''}:${iconItem.id}`}
          title={iconItem.title}
          landmark={landmarks.landmarks[iconItem.id]}
          onSave={(landmark) => {
            landmarks.save(iconItem.id, landmark);
          }}
          onClose={() => {
            setIconItem(null);
            const invoker = iconReturnFocus.current;
            requestAnimationFrame(() => {
              if (invoker?.isConnected === true) invoker.focus();
            });
          }}
        />
      )}
    </aside>
  );
}
