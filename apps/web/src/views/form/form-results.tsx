import { Text } from '@nix/ui';
import type { ReactNode } from 'react';

import { computedValues, planFor } from '@nix/web-collections/properties/computed';
import { PropertyInput } from '@nix/web-collections/properties/property-input';
import type { PropertyDefinition, PropertyValue } from '@nix/web-collections/core/container-model';

/** The same formula engine as saved entries, evaluated without writing the response. */
export function FormResults({
  properties,
  values,
}: {
  readonly properties: readonly PropertyDefinition[];
  readonly values: Readonly<Record<string, PropertyValue>>;
}): ReactNode {
  const formulas = properties.filter((property) => property.type === 'formula');
  if (formulas.length === 0) return null;
  // A draft has no children or server rollups; an unavailable rollup must not become zero.
  const prepared = planFor(properties.filter((property) => property.type !== 'rollup'));
  const item = {
    title: 'This response',
    properties: computedValues({ title: '', properties: values }, prepared),
  };

  return (
    <section aria-label="Calculated results" className="flex min-w-0 flex-col gap-3">
      <Text variant="h4" as="h3">
        Results
      </Text>
      <Text variant="note" tone="muted" className="wrap-anywhere">
        Results update when you leave an input or press Enter. Formulas are calculated from these
        answers.
      </Text>
      {properties.some((property) => property.type === 'rollup') ? (
        <Text variant="note" tone="muted">
          This form preview does not include child rollups. Open a saved entry to see them.
        </Text>
      ) : null}
      {formulas.map((property) => (
        <PropertyInput
          key={property.key}
          item={item}
          property={property}
          onCommit={() => undefined}
        />
      ))}
    </section>
  );
}
