import { UndoProvider } from '@nix/ui';
import { storyContainer, storyItem } from '@nix/web-collections/core/story-container';
import type { ItemProperties } from '@nix/web-collections/properties/use-item-properties';
import type { ReactNode } from 'react';
import { ContextFields } from './context-fields';
import { EventBrief } from './event-brief';

export default { title: 'Nix/Items/Opening from a view' };

const item = storyItem('event', 'Launch review', 1, {
  location: 'Design studio',
  start: '2026-11-12',
  prep_notes: 'Bring the pricing draft.',
});
const schema = storyContainer(
  [item],
  [
    { key: 'location', label: 'Location', type: 'text', options: [], required: false },
    { key: 'start', label: 'Starts', type: 'date', options: [], required: false },
    { key: 'prep_notes', label: 'Prep notes', type: 'long_text', options: [], required: false },
  ],
).schema;
const details: ItemProperties = {
  item,
  schema,
  loading: false,
  error: null,
  retry: () => undefined,
  write: () => Promise.resolve(null),
};

export const RecordFields = {
  render: (): ReactNode => (
    <UndoProvider>
      <ContextFields details={details} fields={['location', 'start']} />
    </UndoProvider>
  ),
};

export const CalendarBrief = {
  render: (): ReactNode => (
    <UndoProvider>
      <EventBrief details={details} view={{ kind: 'event', startKey: 'start', endKey: null }} />
    </UndoProvider>
  ),
};
