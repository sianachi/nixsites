import { Text } from '@nix/ui';
import { useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import type { Item, PropertyDefinition, View } from '@nix/web-collections/core/container-model';
import { storyContainer, storyItem } from '@nix/web-collections/core/story-container';
import { SpreadsheetView } from './spreadsheet-view';

export default { title: 'Nix/Views/Spreadsheet', parameters: { layout: 'padded' } };

const PROPERTIES: PropertyDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: ['Planning', 'In progress', 'Done'],
    required: false,
  },
  { key: 'count', label: 'Count', type: 'number', options: [], required: false },
  { key: 'done', label: 'Done', type: 'checkbox', options: [], required: false },
  { key: 'due', label: 'Due date', type: 'due_date', options: [], required: false },
  {
    key: 'tags',
    label: 'Tags',
    type: 'multi_select',
    options: ['Writing', 'Review'],
    required: false,
  },
  { key: 'priority', label: 'Priority', type: 'priority', options: [], required: false },
];
const VIEW: View = {
  id: 'spreadsheet',
  name: 'Plans',
  kind: 'sheet',
  columns: [],
  groupBy: null,
  groupOrder: [],
  rowBy: null,
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
  properties = PROPERTIES,
}: {
  readonly properties?: readonly PropertyDefinition[];
}): ReactNode {
  const [children, setChildren] = useState<readonly Item[]>([
    storyItem(
      'a',
      'A long plan title that remains readable without pushing the page outside a small phone',
      1,
      {
        status: 'Planning',
        count: 3,
        done: false,
        due: '2026-10-15',
        tags: ['Writing'],
        priority: 2,
      },
    ),
    storyItem('b', 'Write the first draft', 2, {
      status: 'In progress',
      count: 8,
      done: true,
      tags: ['Review'],
      priority: 3,
    }),
  ]);
  const [opened, setOpened] = useState<string | null>(null);
  function apply(itemId: string, properties: Record<string, unknown>): void {
    setChildren((current) =>
      current.map((item) =>
        item.id === itemId ? { ...item, properties: { ...item.properties, ...properties } } : item,
      ),
    );
  }
  const container = storyContainer(children, properties, {
    setProperties: (itemId, properties) => {
      apply(itemId, properties);
      return Promise.resolve(null);
    },
    setPropertiesMany: (writes) => {
      for (const write of writes) apply(write.itemId, write.properties);
      return Promise.resolve({ saved: writes.length, refused: [] });
    },
  });
  return (
    <MemoryRouter>
      <SpreadsheetView container={container} view={VIEW} onOpen={setOpened} />
      {opened === null ? null : (
        <Text as="p" variant="note" role="status">
          Opened item {opened}
        </Text>
      )}
    </MemoryRouter>
  );
}

export const Desktop = { render: (): ReactNode => <Example /> };
export const Phone = { ...Desktop, parameters: { viewport: { defaultViewport: 'mobile1' } } };
export const Tablet = { ...Desktop, parameters: { viewport: { defaultViewport: 'tablet' } } };
export const LongPropertyLabel = {
  render: (): ReactNode => (
    <div role="region" aria-label="Narrow spreadsheet" className="max-w-xs">
      <Example
        properties={[
          {
            key: 'count',
            label: 'EstimatedNumberOfEditorialRevisionsBeforePublication',
            type: 'number',
            options: [],
            required: false,
          },
        ]}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    within(canvasElement).getByRole('grid').focus();
    await userEvent.keyboard('{ArrowRight}');
    const pane = within(canvasElement).getByRole('region', { name: 'Narrow spreadsheet' });
    await waitFor(() => {
      if (pane.scrollWidth > pane.clientWidth)
        throw new Error('The property edit control overflows the narrow spreadsheet');
    });
  },
};
export const DarkDesktop = { ...Desktop, globals: { ground: 'dark' } };
export const DarkPhone = { ...Phone, globals: { ground: 'dark' } };
export const DarkTablet = { ...Tablet, globals: { ground: 'dark' } };
