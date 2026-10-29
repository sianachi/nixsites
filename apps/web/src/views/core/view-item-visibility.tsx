import { Button, Text } from '@nix/ui';
import { useMemo, type ReactNode } from 'react';

import { useHiddenItems } from '../../collections/items/use-hidden-items';
import type { View } from '../../collections/core/container-model';
import type { ContainerData } from '../../collections/core/use-container';

export function ViewItemVisibility({
  container,
  view,
  children,
}: {
  readonly container: ContainerData;
  readonly view: View | null;
  readonly children: (visible: ContainerData) => ReactNode;
}): ReactNode {
  const visibility = useHiddenItems();
  // Child-array identity is the list virtualizer's boundary and avoids repeating large sorts.
  const visible = useMemo(
    () =>
      visibility.hiddenSet.size === 0
        ? container.children
        : container.children.filter((item) => !visibility.hiddenSet.has(item.id)),
    [container.children, visibility.hiddenSet],
  );
  if (
    !visibility.enabled ||
    container.locked ||
    (view !== null && ['chart', 'query', 'form', 'interactive_form'].includes(view.kind))
  )
    return children(container);
  const count = container.children.length - visible.length;
  return (
    <div className="flex flex-col gap-3">
      {count > 0 ? (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <Text as="span" variant="caption" tone="muted">
            {String(count)} hidden
          </Text>
        </div>
      ) : null}
      {count > 0 && visible.length === 0 && container.status === 'ready' ? (
        <div className="flex flex-col items-start gap-2">
          <Text variant="note" tone="muted">
            All items here are hidden for you.
          </Text>
          <Button variant="ghost" onClick={visibility.showAll}>
            Show all hidden items
          </Button>
        </div>
      ) : (
        children({ ...container, children: visible })
      )}
    </div>
  );
}
