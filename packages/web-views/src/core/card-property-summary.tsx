import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type {
  Item,
  PropertyDefinition,
  PropertyValue,
} from '@nix/web-collections/core/container-model';
import {
  hasDisplayValue,
  PropertyValueDisplay,
} from '@nix/web-collections/properties/property-value-display';
import { ValuePopover } from '@nix/web-collections/properties/value-popover';

import { ListCell } from '../list/list-cell';

export function CardPropertySummary({
  item,
  fields,
}: {
  readonly item: Item;
  readonly fields: readonly PropertyDefinition[];
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 empty:hidden">
      {fields
        .filter((field) => hasDisplayValue(item, field))
        .map((field) => (
          <div key={field.key} className="flex min-w-0 items-center gap-1">
            <Text as="span" variant="caption" tone="muted">
              {field.label}
            </Text>
            <PropertyValueDisplay item={item} property={field} />
          </div>
        ))}
    </div>
  );
}

/**
 * A card's properties: the read-only summary when compact, otherwise one editable cell per field.
 * `className` sets the layout of the editable list; the wrapper is left out when there are no fields.
 */
export function CardFields({
  item,
  fields,
  compact,
  className,
  onWrite,
}: {
  readonly item: Item;
  readonly fields: readonly PropertyDefinition[];
  readonly compact: boolean;
  readonly className: string;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
}): ReactNode {
  if (compact) return <CardPropertySummary item={item} fields={fields} />;
  if (fields.length === 0) return null;
  return (
    <div className={className}>
      {fields.map((field) => (
        <ValuePopover
          key={field.key}
          item={item}
          property={field}
          density="chip"
          labelled
          className="max-w-full"
        >
          <ListCell
            item={item}
            property={field}
            density="card"
            onWrite={(value) => onWrite(item.id, field.key, value)}
          />
        </ValuePopover>
      ))}
    </div>
  );
}
