import { Button } from '@nix/ui';
import { type ReactNode, type RefObject } from 'react';

import { PropertyInput } from '@nix/web-collections/properties/property-input';
import { type Item, type PropertyDefinition } from '@nix/web-collections/core/container-model';

interface GridPropertyPanelProps {
  readonly panelRef: RefObject<HTMLDivElement | null>;
  readonly item: Item | undefined;
  readonly property: PropertyDefinition | undefined;
  readonly refusal: string | null;
  readonly onCommit: (item: Item, property: PropertyDefinition, value: unknown) => void;

  /** Escape: abandon the unsent draft and return focus to the grid. */
  readonly onEscape: () => void;
  readonly onDone: () => void;
}

/** The typed control for the active cell's property, shown in the toolbar's popover. */
export function GridPropertyPanel(props: GridPropertyPanelProps): ReactNode {
  const { panelRef, item, property, refusal, onCommit, onEscape, onDone } = props;
  return (
    // Escape cancels the unsent draft before closing can blur its control.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={panelRef}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onEscape();
      }}
    >
      {item !== undefined && property !== undefined ? (
        <PropertyInput
          key={`${item.id}:${property.key}`}
          item={item}
          property={property}
          error={refusal}
          onCommit={(value) => {
            onCommit(item, property, value);
          }}
        />
      ) : null}
      <Button variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
