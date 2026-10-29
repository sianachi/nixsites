import type { ReactNode } from 'react';

import type { PropertyDefinition } from '../core/container-model';
import { PropertyValueDisplay } from './property-value-display';

/**
 * Values as a card or a grid cell shows them: read, never edited.
 */
function property(key: string, label: string, type: string): PropertyDefinition {
  return {
    key,
    label,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  };
}

const ITEM = {
  title: 'Launch checklist',
  properties: {
    status: 'Doing',
    tags: ['Design', 'Q3'],
    priority: 1,
    estimate: 3.5,
    due: '2000-01-01',
    done: true,
    link: 'https://example.com/spec',
  },
};

const PROPERTIES = [
  property('status', 'Status', 'select'),
  property('tags', 'Tags', 'multi_select'),
  property('priority', 'Priority', 'priority'),
  property('estimate', 'Estimate', 'estimate'),
  property('due', 'Due', 'due_date'),
  property('done', 'Done', 'checkbox'),
  property('link', 'Spec', 'url'),
];

export default { title: 'Nix/Views/Property value display', parameters: { layout: 'padded' } };

/** Every common type, stacked as a card face would show them. */
export const CardFace = {
  render: (): ReactNode => (
    <div className="flex w-64 flex-col gap-2 p-3">
      {PROPERTIES.map((entry) => (
        <PropertyValueDisplay key={entry.key} item={ITEM} property={entry} />
      ))}
    </div>
  ),
};

/** One line per value, truncating, as a grid cell shows them. */
export const Cells = {
  render: (): ReactNode => (
    <div className="flex w-40 flex-col gap-2 p-3">
      {PROPERTIES.map((entry) => (
        <PropertyValueDisplay key={entry.key} item={ITEM} property={entry} density="cell" />
      ))}
    </div>
  ),
};

/**
 * A due date already past beside one still ahead. Overdue is told by a glyph and a hidden word as
 * well as the accent tone, so the two read apart without colour.
 */
export const OverdueAndOnTime = {
  render: (): ReactNode => (
    <div className="flex w-64 flex-col gap-2 p-3">
      <PropertyValueDisplay
        item={{ title: 'Late', properties: { due: '2000-01-01' } }}
        property={property('due', 'Due', 'due_date')}
      />
      <PropertyValueDisplay
        item={{ title: 'On time', properties: { due: '2999-01-01' } }}
        property={property('due', 'Due', 'due_date')}
      />
    </div>
  ),
};
