import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';

import type { PropertyDefinition, View } from '../../collections/core/container-model';
import { storyContainer, storyItem } from '../../collections/core/story-container';
import { ListView } from './list-view';

export default { title: 'Nix/Views/Grouped list', parameters: { layout: 'padded' } };

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['To do', 'Doing', 'Done'],
  required: false,
};
const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

const CHILDREN = [
  storyItem('a', 'Draft the brief', 1, { status: 'Doing', owner: 'Ada' }),
  storyItem('b', 'Book the venue', 2, { status: 'To do', owner: 'Grace' }),
  storyItem('c', 'Send invitations', 3, { status: 'To do' }),
  storyItem('d', 'Order supplies', 4, { status: 'Done', owner: 'Ada' }),
  storyItem('e', 'Loose idea', 5, {}, 'canvas'),
];

function view(overrides: Partial<View>): View {
  return {
    id: 'list',
    name: 'Tasks',
    kind: 'list',
    columns: ['owner'],
    groupBy: 'status',
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
    ...overrides,
  };
}

function Example({
  overrides = {},
  children = CHILDREN,
  properties = [STATUS, OWNER],
}: {
  readonly overrides?: Partial<View>;
  readonly children?: typeof CHILDREN;
  readonly properties?: readonly PropertyDefinition[];
}): ReactNode {
  return (
    <MemoryRouter>
      <ListView
        container={storyContainer(children, properties)}
        view={view(overrides)}
        onOpen={() => undefined}
      />
    </MemoryRouter>
  );
}

export const BySelect = { render: (): ReactNode => <Example /> };
export const ByKind = { render: (): ReactNode => <Example overrides={{ groupBy: '$type' }} /> };
export const SectionFolded = {
  render: (): ReactNode => <Example overrides={{ collapsedGroups: ['Done'] }} />,
};
export const GroupingGone = {
  render: (): ReactNode => <Example overrides={{ groupBy: 'priority' }} />,
};
export const LongLabels = {
  render: (): ReactNode => (
    <Example
      children={[
        storyItem('long', 'NotesForTheEditorialReviewAndPublicationDecision', 1, {
          status: 'WaitingForTheEditorialReviewAndPublicationDecision',
          owner: 'PublishingTeamResponsibleForTheEditorialReview',
        }),
      ]}
      properties={[
        { ...STATUS, options: ['WaitingForTheEditorialReviewAndPublicationDecision'] },
        { ...OWNER, label: 'PublishingTeamResponsibleForTheEditorialReview' },
      ]}
    />
  ),
};
export const DarkBySelect = { ...BySelect, globals: { ground: 'dark' } };
export const DarkSectionFolded = { ...SectionFolded, globals: { ground: 'dark' } };
export const Phone = { ...BySelect, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };

const EXTRA: PropertyDefinition[] = [
  STATUS,
  OWNER,
  { key: 'area', label: 'Area', type: 'text', options: [], required: false },
  { key: 'note', label: 'Note', type: 'text', options: [], required: false },
];
const PHONE = { parameters: { viewport: { defaultViewport: 'mobile1' } } };
/** Four properties configured: only the first two are drawn on the row, the rest live in the item. */
export const PhoneManyFields = {
  ...PHONE,
  render: (): ReactNode => (
    <Example
      properties={EXTRA}
      overrides={{ groupBy: null, columns: ['status', 'owner', 'area', 'note'] }}
    />
  ),
};
export const PhoneLongTitle = {
  ...PHONE,
  render: (): ReactNode => (
    <Example
      overrides={{ groupBy: null, columns: ['status', 'owner'] }}
      children={[
        storyItem(
          'long',
          'Notes for the editorial review and publication decision on the spring programme',
          1,
          { status: 'Doing' },
        ),
      ]}
    />
  ),
};
