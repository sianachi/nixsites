import type { ReactNode } from 'react';
import { useState } from 'react';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import type { PropertyDefinition } from '@nix/web-collections/core/container-model';
import { storyContainer, storyItem } from '@nix/web-collections/core/story-container';
import { recordStoryView } from '@nix/web-collections/core/story-container';
import { RecordViewStory } from '../list/record-view-story';
import { BoardView } from './board-view';

export default { title: 'Nix/Views/Board', parameters: { layout: 'padded' } };
const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};
const START = [
  storyItem('a', 'Plan the week', 1, { status: 'To do' }),
  storyItem('b', 'Write a poem about the first signs of autumn', 2, { status: 'Doing' }),
  storyItem('c', 'Choose our next trip together', 3, { status: 'Done' }),
];

function Example({
  status = STATUS,
  cards = START,
}: {
  readonly status?: PropertyDefinition;
  readonly cards?: typeof START;
}): ReactNode {
  const [children, setChildren] = useState(cards);
  const container = storyContainer(children, [status], {
    setProperties: (id, values) => {
      setChildren((current) =>
        current.map((item) =>
          item.id === id ? { ...item, properties: { ...item.properties, ...values } } : item,
        ),
      );
      return Promise.resolve(null);
    },
  });
  return (
    <RecordViewStory>
      <BoardView
        container={container}
        view={recordStoryView('board', { groupBy: 'status' })}
        onOpen={() => undefined}
      />
    </RecordViewStory>
  );
}

export const Plans = { render: (): ReactNode => <Example /> };
export const NarrowPlans = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example />
    </div>
  ),
};
export const LongLabels = {
  render: (): ReactNode => (
    <div className="max-w-xs">
      <Example
        status={{
          ...STATUS,
          label: 'Publishing stage for a very long property label',
          options: ['WaitingForTheEditorialReviewAndPublicationDecision'],
        }}
        cards={[
          storyItem('long', 'NotesForTheEditorialReviewAndPublicationDecision', 1, {
            status: 'WaitingForTheEditorialReviewAndPublicationDecision',
          }),
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const column = within(canvasElement).getByRole('region', {
      name: 'WaitingForTheEditorialReviewAndPublicationDecision',
    });
    await waitFor(() => {
      if (column.scrollWidth > column.clientWidth)
        throw new Error('The add-item control overflows its board column');
    });
  },
};
export const RowActions = {
  ...Plans,
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const target = within(canvasElement).getByRole('button', { name: 'Plan the week' });
    target.focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
  },
};
export const DarkPlans = { ...Plans, globals: { ground: 'dark' } };
export const DarkNarrowPlans = { ...NarrowPlans, globals: { ground: 'dark' } };
export const DarkRowActions = { ...RowActions, globals: { ground: 'dark' } };
