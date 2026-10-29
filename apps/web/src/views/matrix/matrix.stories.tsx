import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { Item, PropertyDefinition, View } from '../../collections/core/container-model';
import { storyContainer, storyItem } from '../../collections/core/story-container';
import { MatrixView } from './matrix-view';

export default { title: 'Nix/Views/Matrix', parameters: { layout: 'padded' } };

const URGENCY: PropertyDefinition = {
  key: 'urgency',
  label: 'Urgency',
  type: 'select',
  options: ['Urgent', 'Not urgent'],
  required: false,
};
const IMPORTANCE: PropertyDefinition = {
  key: 'importance',
  label: 'Importance',
  type: 'select',
  options: ['Important', 'Not important'],
  required: false,
};

const CARDS = [
  storyItem('a', 'Fix the leaking tap', 1, { urgency: 'Urgent', importance: 'Important' }),
  storyItem('b', 'Plan the garden', 2, { urgency: 'Not urgent', importance: 'Important' }),
  storyItem('c', 'Reply to the group chat', 3, {
    urgency: 'Urgent',
    importance: 'Not important',
  }),
  storyItem('d', 'Sort old photos', 4, { urgency: 'Not urgent', importance: 'Not important' }),
  storyItem('e', 'Untriaged idea', 5),
];

const VIEW: View = {
  id: 'matrix',
  name: 'Priorities',
  kind: 'matrix',
  columns: [],
  groupBy: 'urgency',
  groupOrder: [],
  rowBy: 'importance',
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
  view = VIEW,
  refuse,
  cards = CARDS,
  properties = [URGENCY, IMPORTANCE],
}: {
  readonly view?: View;
  readonly refuse?: string;
  readonly cards?: readonly Item[];
  readonly properties?: readonly PropertyDefinition[];
}): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>(cards);
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
  });
  return (
    <MemoryRouter>
      <MatrixView container={container} view={view} onOpen={() => undefined} />
    </MemoryRouter>
  );
}

export const Priorities = { render: (): ReactNode => <Example /> };
export const NoRows = { render: (): ReactNode => <Example view={{ ...VIEW, rowBy: null }} /> };
/** Use a card's "Move to…" menu: the write is refused and the card stays where it was. */
export const MoveRefused = {
  render: (): ReactNode => <Example refuse="This item is read-only." />,
};
/** Two cards only, so most cells are empty: press "Show empty rows and columns". */
export const MostlyEmpty = {
  render: (): ReactNode => <Example cards={CARDS.slice(0, 2)} />,
};
export const LongLabels = {
  render: (): ReactNode => (
    <Example
      cards={[
        storyItem('long', 'NotesForTheEditorialReviewAndPublicationDecision', 1, {
          urgency: 'WaitingForTheEditorialReviewAndPublicationDecision',
          importance: 'EssentialForTheNextPublicationAndArchive',
        }),
      ]}
      properties={[
        { ...URGENCY, options: ['WaitingForTheEditorialReviewAndPublicationDecision'] },
        { ...IMPORTANCE, options: ['EssentialForTheNextPublicationAndArchive'] },
      ]}
    />
  ),
};
export const Phone = { ...Priorities, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const DarkMoveRefused = { ...MoveRefused, globals: { ground: 'dark' } };
export const DarkMostlyEmpty = { ...MostlyEmpty, globals: { ground: 'dark' } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
export const DarkPriorities = { ...Priorities, globals: { ground: 'dark' } };
export const DarkNoRows = { ...NoRows, globals: { ground: 'dark' } };
