import { Button } from '@nix/ui';
import { type ReactNode, type RefObject } from 'react';

import { PropertyInput } from '@nix/web-collections/properties/property-input';
import { type Item, type PropertyDefinition } from '@nix/web-collections/core/container-model';

const dayOffset = (days: number): string => {
  const date = new Date(Date.now() + days * 864e5);
  return new Date(date.getTime() - date.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
};

/** One-tap values above the typed control: dates relative to today, small numbers. */
function quickPicks(type: string): readonly (readonly [string, string | number])[] {
  if (type === 'date')
    return [
      ['Today', dayOffset(0)],
      ['Tomorrow', dayOffset(1)],
      ['Next week', dayOffset(7)],
    ];
  if (type === 'number') return [1, 2, 3, 5, 8].map((n) => [String(n), n] as const);
  return [];
}

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
      {/* Drawn first, placed after the input in the DOM so the popover still focuses the input. */}
      {item !== undefined && property !== undefined && quickPicks(property.type).length > 0 ? (
        <div className="order-first flex flex-wrap gap-2">
          {quickPicks(property.type).map(([label, value]) => (
            <Button
              key={label}
              variant="secondary"
              className="flex-1"
              onClick={() => {
                onCommit(item, property, value);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : null}
      <Button variant="secondary" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
