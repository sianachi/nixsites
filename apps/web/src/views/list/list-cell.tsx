import { useState, type ReactNode } from 'react';

import {
  PropertyInput,
  type PropertyInputDensity,
} from '../../collections/properties/property-input';
import { useTrackWrite } from '../../collections/properties/value-popover';
import type {
  Item,
  PropertyDefinition,
  PropertyValue,
} from '../../collections/core/container-model';

/**
 * One editable cell in the list.
 *
 * **The refusal belongs to the cell, not to the table.** A write is refused for one property of one
 * item, and a banner above the table that says so leaves somebody counting rows to find which cell
 * it is about. So the answer to a cell's own edit is held here, beside the control that asked -
 * which is also why the list does not draw the container's `writeError`: the cell has already
 * reported it, and drawing both is two banners for one failure.
 *
 * **Held at the nearest durable UI boundary.** A standalone cell owns the refusal locally. A
 * virtualized list supplies the optional controlled value so unmounting an off-screen row does not
 * erase its refusal. It still stays outside `useContainer`: this is the answer to one edit attempt,
 * not server data for the container to mirror and clear.
 *
 * The control itself is `PropertyInput`, unchanged in behaviour: it already commits typed values on
 * blur or Enter and discrete ones on the choice, so a cell writes once per completed edit and never
 * once per keystroke.
 */

export interface ListCellProps {
  readonly item: Item;
  readonly property: PropertyDefinition;

  /** Writes the value and answers with the reason it was refused, or null when it was stored. */
  readonly onWrite: (value: PropertyValue) => Promise<string | null>;

  /** Optional lifted refusal state, retained when virtualization unmounts this cell. */
  readonly refusal?: string | null;
  readonly onRefusalChange?: (refusal: string | null) => void;
  readonly tabIndex?: number;
  readonly density?: PropertyInputDensity;
}

export function ListCell({
  item,
  property,
  onWrite,
  refusal: controlledRefusal,
  onRefusalChange,
  tabIndex,
  density = 'cell',
}: ListCellProps): ReactNode {
  const [localRefusal, setLocalRefusal] = useState<string | null>(null);
  const refusal = onRefusalChange === undefined ? localRefusal : (controlledRefusal ?? null);
  const setRefusal = onRefusalChange ?? setLocalRefusal;
  const trackWrite = useTrackWrite();

  return (
    <PropertyInput
      item={item}
      property={property}
      density={density}
      error={refusal}
      {...(tabIndex === undefined ? {} : { tabIndex })}
      onCommit={(value) => {
        // Cleared before the attempt rather than only replaced after it: leaving the last refusal
        // on screen while the next write is in flight says the new value has already failed.
        setRefusal(null);

        trackWrite(
          onWrite(value).then((answer) => {
            setRefusal(answer);
            return answer === null;
          }),
        );
      }}
    />
  );
}
