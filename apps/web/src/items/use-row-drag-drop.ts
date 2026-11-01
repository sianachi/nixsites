import { useState, type DragEvent, type HTMLAttributes } from 'react';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { collectDropped } from './drop-upload';
import { dropZoneAt, type DropZone } from './tree-geometry';

interface RowDragDropArgs {
  readonly item: TreeItem;
  readonly tree: WorkspaceTree;
  /** The sibling above, for a drop on the row's bottom edge that lands "before" it. */
  readonly previousId: string | null;
  readonly dragged: string | null;
  readonly setDragged: (itemId: string | null) => void;
  readonly onDropFiles: (dropped: (File | FileSystemEntry)[], parentId: string | null) => void;
}

/** A row's drag source and drop target: the landing zone it is showing and the handlers that drive it. */
interface RowDragDrop {
  readonly zone: DropZone | null;
  readonly dropping: boolean;
  readonly dragProps: HTMLAttributes<HTMLDivElement>;
}

export function useRowDragDrop(args: RowDragDropArgs): RowDragDrop {
  const { item, tree, previousId, dragged, setDragged, onDropFiles } = args;
  const [zone, setZone] = useState<DropZone | null>(null);
  const dropping = zone !== null && dragged !== item.id;

  function onDragStart(event: DragEvent<HTMLDivElement>): void {
    setDragged(item.id);
    event.dataTransfer.effectAllowed = 'move';
    // Set, though nothing reads it: without data attached, Firefox refuses to start the drag.
    event.dataTransfer.setData('text/plain', item.id);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();

    const landing = zone;
    setZone(null);

    if (event.dataTransfer.types.includes('Files')) {
      event.stopPropagation(); // handled here, not as an empty-space drop on the sidebar
      onDropFiles(
        collectDropped(event.dataTransfer),
        landing === 'inside' ? item.id : item.parentId,
      );
      return;
    }

    if (dragged === null || dragged === item.id || landing === null) {
      return;
    }

    // The server refuses an item dropped into its own subtree, so the one gesture that could break
    // the tree is the one it will not perform.
    void (landing === 'inside'
      ? tree.move(dragged, item.id, null)
      : tree.move(dragged, item.parentId, landing === 'after' ? item.id : previousId));

    setDragged(null);
  }

  const dragProps = {
    draggable: true,
    onDragStart,
    onDragEnd: () => {
      setDragged(null);
      setZone(null);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      // A text or link drag is not ours to take; an OS file drag is.
      if (dragged === null && !event.dataTransfer.types.includes('Files')) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      setZone(dropZoneAt(event.clientY - box.top, box.height));
    },
    onDragLeave: () => {
      setZone(null);
    },
    onDrop,
  };

  return { zone, dropping, dragProps };
}
