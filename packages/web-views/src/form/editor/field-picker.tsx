import { Field, Select } from '@nix/ui';
import type { ReactNode } from 'react';

import type { FormBlock, PropertyDefinition } from '@nix/web-collections/core/container-model';
import { isComputedType } from '@nix/web-collections/core/property-types';

export function FieldPicker({
  block,
  schema,
  onChange,
}: {
  readonly block: FormBlock;
  readonly schema: readonly PropertyDefinition[];
  readonly onChange: (block: FormBlock) => void;
}): ReactNode {
  return (
    <Field label="Stores in">
      {(control) => (
        <Select
          {...control}
          value={block.propertyKey ?? ''}
          onChange={(event) => {
            const propertyKey = event.target.value || null;
            const textBacked =
              schema.find((property) => property.key === propertyKey)?.type === 'text';
            onChange({
              ...block,
              propertyKey,
              identityRole: textBacked ? block.identityRole : null,
            });
          }}
        >
          {/* Computed properties are left out: a form writes children, and nothing writes
                      a computed value. Offering one would build a question with no control and no
                      way to answer it. */}
          {schema
            .filter((property) => !isComputedType(property.type))
            .map((property) => (
              <option key={property.key} value={property.key}>
                {property.label}
              </option>
            ))}
        </Select>
      )}
    </Field>
  );
}
