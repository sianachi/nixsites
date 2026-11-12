import type { KeptItem } from '@nix/api-client';
import { Button, Text, cn } from '@nix/ui';
import { useBookmarksStore } from '@nix/web-collections/items/use-bookmarks';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import type { ItemLandmarks } from '@nix/web-foundation/lib/item-landmarks';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import type { ReactNode } from 'react';
import { BookmarkButton } from '../bookmarks/bookmark-button';
import { ItemLandmarkIcon } from './item-landmark-dialog';

export function useExplorerPins(tree: WorkspaceTree): {
  readonly roots: readonly TreeItem[];
  readonly shortcuts: readonly KeptItem[];
} {
  const { workspaceId } = useWorkspace();
  const { hiddenSet } = useHiddenItems();
  const bookmarks = useBookmarksStore((state) => state.items);
  const keptIds = useBookmarksStore((state) => state.keptIds);
  const roots = tree.childrenOf(null).filter((item) => !hiddenSet.has(item.id));
  const rootIds = new Set(roots.map((item) => item.id));
  return {
    roots: roots.sort((a, b) => Number(keptIds.has(b.id)) - Number(keptIds.has(a.id))),
    // A nested pin is a shortcut. Moving its tree row would change the folder it appears to be in.
    shortcuts: bookmarks.filter(
      (item) =>
        item.workspaceId === workspaceId &&
        !hiddenSet.has(item.itemId) &&
        !rootIds.has(item.itemId),
    ),
  };
}

export function ExplorerPin({
  pin,
  tree,
  landmarks,
  selected,
  className,
  onOpen,
}: {
  readonly pin: KeptItem;
  readonly tree: WorkspaceTree;
  readonly landmarks: ItemLandmarks;
  readonly selected?: boolean;
  readonly className?: string;
  readonly onOpen: (id: string) => void;
}): ReactNode {
  const item = tree.find(pin.itemId) ?? { type: pin.type, title: pin.title ?? '' };
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-md',
        selected ? 'bg-accent/14' : 'hover:bg-accent/8',
        className,
      )}
    >
      <Button
        variant="ghost"
        aria-current={selected ? 'page' : undefined}
        className="min-w-0 flex-1 justify-start px-2 text-left pointer-coarse:min-h-(--control-lg)"
        onClick={() => {
          onOpen(pin.itemId);
        }}
      >
        <ItemLandmarkIcon item={item} landmark={landmarks[pin.itemId]} />
        <Text as="span" variant="body" truncate>
          {item.title || 'Untitled'}
        </Text>
      </Button>
      <BookmarkButton itemId={pin.itemId} title={item.title} compact pin />
    </div>
  );
}
