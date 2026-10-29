import { useClickSelects } from '../../collections/core/item-open-click';
import { useOptionalItemSelection } from '../../collections/core/item-selection-context';
import { rowGestures } from '../../collections/core/use-item-selection';

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
