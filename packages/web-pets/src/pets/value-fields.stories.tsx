import { within } from '@testing-library/dom';
import type { ReactNode } from 'react';

import { ValueFields } from './approval/value-fields';

export default { title: 'Nix/Companion/Review fields', parameters: { layout: 'padded' } };

export const NestedValues = {
  render: (): ReactNode => (
    <div className="w-full max-w-lg">
      <ValueFields
        label="Proposed values"
        value={{
          projectName: 'Release',
          filter: { state: 'Ready', archived: false },
          assignees: ['Aster', 'Rowan'],
          dueDate: null,
          note: '{"keep":"this is literal text"}',
          choices: [],
          extraFields: {},
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('textbox', { name: /project name/iu });
    if (!field.hasAttribute('readonly')) throw new Error('Review fields must be read-only.');
    canvas.getByDisplayValue('No');
    canvas.getByText('No items');
    canvas.getByText('No fields');
  },
};

export const LongText = {
  render: (): ReactNode => (
    <div className="w-full max-w-lg">
      <ValueFields
        value={{
          destination: `https://example.test/${'release-review/'.repeat(24)}`,
          comment: 'First line\n\nThis entire comment stays available for review.\nLast line.',
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    const field = await canvas.findByRole('textbox', { name: 'Destination' });
    if (field.tagName !== 'TEXTAREA' || !field.hasAttribute('readonly'))
      throw new Error('Long review text must wrap in a read-only text area.');
  },
};

export const ExactNamesAndCollections = {
  render: (): ReactNode => (
    <div className="w-full max-w-lg">
      <ValueFields
        label="Values to review"
        value={{
          user_id: 'Underscore',
          'user-id': 'Hyphen',
          userId: 'Camel case',
          ' user_id ': 'Surrounding spaces',
          list: ['x'],
          group: { 'Item 1': 'x' },
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }: { readonly canvasElement: HTMLElement }): Promise<void> => {
    const canvas = within(canvasElement);
    await canvas.findByText('Field name: "user_id"');
    canvas.getByText('Field name: "user-id"');
    canvas.getByText('Field name: "userId"');
    canvas.getByText('Field name: "\\u0020user_id\\u0020"');
    canvas.getByRole('textbox', { name: 'Item 1 of 1' });
    canvas.getByRole('textbox', { name: 'Item 1' });
  },
};
