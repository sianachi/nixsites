import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { PropertyDefinition } from '../../collections/core/container-model';
import { SchemaEditor } from './schema-editor';
import { recordStoryView, storyContainer } from '../../collections/core/story-container';
import { ViewEditor } from './view-editor';
import { ViewSwitcher } from './view-switcher';

export default { title: 'Nix/Views/Settings', parameters: { layout: 'padded' } };

const fields: PropertyDefinition[] = [
  { key: 'name', label: 'Name', type: 'text', options: [], required: false },
  {
    key: 'calculation',
    label: 'LongPropertyNameWithoutSpacesToExerciseWrappingInTheSettingsPanel',
    type: 'formula',
    options: [],
    required: false,
    expression: '[name]',
  },
];
const views = [
  recordStoryView('list', {
    id: 'list',
    name: 'LongViewNameWithoutSpacesToExerciseTheViewSwitcherAndSettings',
  }),
  recordStoryView('board', { id: 'board', name: 'Board' }),
];
const container = storyContainer([], fields, {
  views: { views, default: 'list', hideDocument: false, unrenderable: [] },
});
const noop = (): void => undefined;

export const Fields = {
  render: (): ReactNode => <SchemaEditor container={container} inline open onClose={noop} />,
};

export const Views = {
  render: (): ReactNode => (
    <MemoryRouter>
      <ViewEditor container={container} inline open onClose={noop} />
    </MemoryRouter>
  ),
};

export const ViewTabs = {
  render: (): ReactNode => (
    <ViewSwitcher
      views={views}
      documentLabel="Document"
      activeViewId="board"
      unrenderable={[]}
      onSelect={noop}
    />
  ),
};
