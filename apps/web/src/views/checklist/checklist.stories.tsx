import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { Item, PropertyDefinition, View } from '../../collections/core/container-model';
import { storyContainer, storyItem } from '../../collections/core/story-container';
import { ChecklistView } from './checklist-view';

export default { title: 'Nix/Views/Checklist', parameters: { layout: 'padded' } };

const DONE: PropertyDefinition = {
  key: 'done',
  label: 'Done',
  type: 'checkbox',
  options: [],
  required: false,
};
const AISLE: PropertyDefinition = {
  key: 'aisle',
  label: 'Aisle',
  type: 'text',
  options: [],
  required: false,
};

const LINES = [
  storyItem('a', 'Milk', 1, { done: true, aisle: 'Dairy' }),
  storyItem('b', 'Sourdough loaf', 2, { aisle: 'Bakery' }),
  storyItem('c', 'Eggs', 3, { done: true }),
  storyItem('d', 'Coffee beans', 4, { aisle: 'Aisle 7' }),
  storyItem('e', 'A very long line that wraps onto a second row on a narrow phone screen', 5),
];

const VIEW: View = {
  id: 'checklist',
  name: 'Shopping',
  kind: 'checklist',
  columns: ['aisle'],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
};

function Example({
  properties = [DONE, AISLE],
  refuse,
  lines = LINES,
}: {
  readonly properties?: readonly PropertyDefinition[];
  readonly refuse?: string;
  readonly lines?: readonly Item[];
}): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>(lines);
  const container = storyContainer(children, properties, {
    setProperties: (itemId, values) => {
      if (refuse !== undefined) return Promise.resolve(refuse);
      setChildren((current) =>
        current.map((entry) =>
          entry.id === itemId
            ? { ...entry, properties: { ...entry.properties, ...values } }
            : entry,
        ),
      );
      return Promise.resolve(null);
    },
    create: (title) => {
      setChildren((current) => [...current, storyItem(`n-${title}`, title, current.length + 1)]);
      return Promise.resolve(null);
    },
  });
  return (
    <MemoryRouter>
      <div className="max-w-md">
        <ChecklistView container={container} view={VIEW} onOpen={() => undefined} />
      </div>
    </MemoryRouter>
  );
}

export const Shopping = { render: (): ReactNode => <Example /> };
export const TicksRefused = {
  render: (): ReactNode => <Example refuse="This item is read-only." />,
};
export const NothingToTick = { render: (): ReactNode => <Example properties={[AISLE]} /> };
export const LongLabels = {
  render: (): ReactNode => (
    <Example
      lines={[
        storyItem('long', 'SuppliesForTheEditorialReviewAndPublicationDecision', 1, {
          aisle: 'PublishingTeamResponsibleForTheEditorialReview',
        }),
      ]}
    />
  ),
};
export const DarkShopping = { ...Shopping, globals: { ground: 'dark' } };
export const DarkNothingToTick = { ...NothingToTick, globals: { ground: 'dark' } };
export const Phone = { ...Shopping, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
