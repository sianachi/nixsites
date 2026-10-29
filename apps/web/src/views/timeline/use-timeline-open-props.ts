import { useClickSelects } from '@nix/web-collections/core/item-open-click';
import { useOptionalItemSelection } from '@nix/web-collections/core/item-selection-context';
import { rowGestures } from '@nix/web-collections/core/use-item-selection';

export function useTimelineOpenProps(
  onOpen: (itemId: string) => void,
): (itemId: string) => ReturnType<typeof rowGestures> {
  const selection = useOptionalItemSelection();
  const clickSelects = useClickSelects();
  const openBeside = selection?.openBeside;
  return (itemId) =>
    rowGestures(
      selection,
      itemId,
      selection?.shown ?? [],
      () => {
        onOpen(itemId);
      },
      openBeside === undefined
        ? undefined
        : () => {
            openBeside(itemId);
          },
      clickSelects,
    );
}
