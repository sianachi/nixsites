import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import type { Item, PropertyDefinition } from '@nix/web-collections/core/container-model';
import {
  hasDisplayValue,
  PropertyValueDisplay,
} from '@nix/web-collections/properties/property-value-display';

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
