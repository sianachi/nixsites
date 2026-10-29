import { useState, type ReactElement } from 'react';
import { within } from '@testing-library/dom';

import {
  filterGroup,
  type PropertyDefinition,
  type ViewFilterRule,
} from '../../collections/core/container-model';
import { FilterRulesEditor } from '../core/filter-rules-editor';

/**
 * The filter rules editor in each of its shapes - plain conditions, an "any of" group, the
 * structural query fields, a full set at the ceiling - so axe sees every control on both grounds.
 */

export default { title: 'Nix/Views/Filter rules', parameters: { layout: 'padded' } };

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'due_date', label: 'Due', type: 'due_date', options: [], required: false },
  { key: 'status', label: 'Status', type: 'select', options: ['Todo', 'Doing'], required: false },
  { key: 'points', label: 'Points', type: 'number', options: [], required: false },
  { key: 'score', label: 'Score', type: 'formula', options: [], required: false },
];

function Harness(props: {
  readonly initial: readonly ViewFilterRule[];
  readonly scope?: 'query' | 'container';
}): ReactElement {
  const [rules, setRules] = useState<readonly ViewFilterRule[]>(props.initial);
  return (
    <div className="max-w-3xl">
      <FilterRulesEditor
        rules={rules}
        schema={SCHEMA}
        scope={props.scope ?? 'query'}
        onChange={setRules}
      />
    </div>
  );
}

/** A query with a structural field, a day token and an "any of" group. */
export function QueryWithGroup(): ReactElement {
  return (
    <Harness
      initial={[
        { property: '$type', operator: 'equals', value: 'task' },
        { property: 'due_date', operator: 'on-or-after', value: 'start-of-week' },
        filterGroup([
          { property: 'status', operator: 'equals', value: 'Doing' },
          { property: 'points', operator: 'greater-than', value: '3' },
        ]),
      ]}
    />
  );
}

/** A container view's filters: the same operators, no structural fields suggested. */
export function ContainerFilters(): ReactElement {
  return (
    <Harness
      scope="container"
      initial={[
        { property: 'status', operator: 'is-not-empty', value: '' },
        { property: 'due_date', operator: 'within-last', value: '7' },
      ]}
    />
  );
}

export function ComputedQueryRule(): ReactElement {
  return <Harness initial={[{ property: 'score', operator: 'greater-than', value: '3' }]} />;
}

export function ComputedContainerRule(): ReactElement {
  return (
    <Harness
      scope="container"
      initial={[{ property: 'score', operator: 'greater-than', value: '3' }]}
    />
  );
}

/** Eight conditions: the adding buttons are disabled and the note says why. */
export function AtTheCeiling(): ReactElement {
  return (
    <Harness
      initial={Array.from({ length: 8 }, (_unused, index) => ({
        property: `field_${String(index + 1)}`,
        operator: 'is-not-empty',
        value: '',
      }))}
    />
  );
}

export const NarrowPane = {
  render: (): ReactElement => (
    <section aria-label="Narrow filter editor" className="w-64 max-w-full">
      <QueryWithGroup />
    </section>
  ),
  play: ({ canvasElement }: { readonly canvasElement: HTMLElement }): void => {
    const region = within(canvasElement).getByRole('region', { name: 'Narrow filter editor' });
    if (region.scrollWidth > region.clientWidth) {
      throw new Error('Filter controls must fit within a narrow pane.');
    }
  },
};
export const DarkNarrowPane = { ...NarrowPane, globals: { ground: 'dark' } };
