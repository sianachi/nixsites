import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import { ValueFields } from '../../../pets/approval/value-fields';
import { PropertyValueList } from '../../../pets/approval/write-text';

it('shows nested property values as read-only fields and preserves all empty states', () => {
  render(
    <PropertyValueList
      propertiesJson={JSON.stringify({
        profileData: {
          displayName: 'Aster',
          active: true,
          count: 0,
          missing: null,
          emptyText: '',
          tags: ['Ready', 'Review'],
          emptyList: [],
          emptyObject: {},
          literal: '{"keep":"literal JSON"}',
          multiline: 'First line\nLast line',
        },
      })}
    />,
  );
  expect(screen.getByRole('group', { name: /profile data/iu })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /display name/iu })).toHaveValue('Aster');
  expect(screen.getByRole('textbox', { name: /active/iu })).toHaveValue('Yes');
  expect(screen.getByRole('textbox', { name: /count/iu })).toHaveValue('0');
  expect(screen.getByRole('textbox', { name: /missing/iu })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: /missing/iu })).toHaveAttribute(
    'placeholder',
    'No value',
  );
  expect(screen.getByRole('textbox', { name: /empty text/iu })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: /empty text/iu })).toHaveAttribute(
    'placeholder',
    'Empty text',
  );
  expect(screen.getByDisplayValue('Ready')).toBeTruthy();
  expect(screen.getByDisplayValue('Review')).toBeTruthy();
  expect(screen.getByText('No items')).toBeTruthy();
  expect(screen.getByText('No fields')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /literal/iu })).toHaveValue('{"keep":"literal JSON"}');
  expect(screen.getByRole('textbox', { name: /multiline/iu })).toHaveValue('First line\nLast line');
  expect(screen.getAllByRole('textbox').every((field) => field.hasAttribute('readonly'))).toBe(
    true,
  );
  expect(screen.queryByText(/"displayName":/u)).toBeNull();
});

it('keeps long text complete and focusable without letting a review field change it', async () => {
  const text = `https://example.test/${'long-path/'.repeat(60)}\nLast line stays visible.`;
  render(<ValueFields value={{ destination: text }} />);
  const field = screen.getByRole('textbox', { name: 'Destination' });
  const user = userEvent.setup();
  await user.tab();
  expect(field).toHaveFocus();
  expect(field.tagName).toBe('TEXTAREA');
  expect(field).toHaveValue(text);
  await user.type(field, 'Changed value.');
  expect(field).toHaveValue(text);
  expect(screen.getByText('Review only')).toBeTruthy();
});

it('distinguishes missing, empty, boolean and number values from text containing their labels', () => {
  render(
    <ValueFields
      value={{
        missing: null,
        blank: '',
        enabled: true,
        count: 0,
        missingLabel: 'No value',
        blankLabel: 'Empty text',
        enabledLabel: 'Yes',
        countLabel: '0',
      }}
    />,
  );
  expect(screen.getByRole('textbox', { name: 'Missing' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Missing' })).toHaveAccessibleDescription(/No value/u);
  expect(screen.getByRole('textbox', { name: 'Blank' })).toHaveValue('');
  expect(screen.getByRole('textbox', { name: 'Blank' })).toHaveAccessibleDescription(/Empty text/u);
  expect(screen.getByRole('textbox', { name: 'Enabled' })).toHaveAccessibleDescription(
    /Yes or no/u,
  );
  expect(screen.getByRole('textbox', { name: 'Count' })).toHaveAccessibleDescription(/Number/u);
  expect(screen.getByRole('textbox', { name: /missing label/iu })).toHaveValue('No value');
  expect(screen.getByRole('textbox', { name: /blank label/iu })).toHaveValue('Empty text');
  expect(screen.getByRole('textbox', { name: /enabled label/iu })).toHaveValue('Yes');
  expect(screen.getByRole('textbox', { name: /count label/iu })).toHaveValue('0');
  expect(screen.getByRole('textbox', { name: /missing label/iu })).not.toHaveAttribute(
    'placeholder',
  );
});

it('preserves property names that resemble JavaScript metadata as ordinary data', () => {
  render(
    <PropertyValueList propertiesJson='{"__proto__":{"label":"Keep this field"},"constructor":"Keep this value"}' />,
  );
  expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('Keep this field');
  expect(screen.getByRole('textbox', { name: 'Constructor' })).toHaveValue('Keep this value');
});

it('keeps malformed and empty property documents out of the review', () => {
  const { container, rerender } = render(<PropertyValueList propertiesJson="not valid data" />);
  expect(container).toBeEmptyDOMElement();
  rerender(<PropertyValueList propertiesJson="{}" />);
  expect(container).toBeEmptyDOMElement();
});

it('keeps exact field names visible when friendly labels collapse distinct source keys', () => {
  render(
    <ValueFields
      value={{
        user_id: 'Underscore',
        'user-id': 'Hyphen',
        userId: 'Camel case',
        ' user_id ': 'Surrounding spaces',
        '\tuser_id\n': 'Surrounding control characters',
      }}
    />,
  );
  const fields: readonly (readonly [string, string])[] = [
    ['Underscore', '"user_id"'],
    ['Hyphen', '"user-id"'],
    ['Camel case', '"userId"'],
    ['Surrounding spaces', '"\\u0020user_id\\u0020"'],
    ['Surrounding control characters', '"\\tuser_id\\n"'],
  ];
  for (const [value, source] of fields) {
    const field = screen.getByDisplayValue(value);
    expect(field).toHaveAccessibleDescription(`Field name: ${source}`);
    expect(screen.getByText(`Field name: ${source}`)).toBeVisible();
    expect(field).toHaveAttribute('readonly');
  }
});

it('distinguishes list positions from named fields and describes nonempty collection types', () => {
  render(
    <>
      <ValueFields label="List example" value={{ items: ['x'] }} />
      <ValueFields label="Group example" value={{ items: { 'Item 1': 'x' } }} />
    </>,
  );
  const list = within(screen.getByRole('group', { name: 'List example' })).getByRole('group', {
    name: 'Items',
  });
  const group = within(screen.getByRole('group', { name: 'Group example' })).getByRole('group', {
    name: 'Items',
  });
  expect(list).toHaveAccessibleDescription(/List, 1 item/u);
  expect(group).toHaveAccessibleDescription(/Group, 1 field/u);
  expect(within(list).getByText(/List, 1 item/u)).toBeVisible();
  expect(within(group).getByText(/Group, 1 field/u)).toBeVisible();
  expect(within(list).getByRole('textbox', { name: 'Item 1 of 1' })).toHaveValue('x');
  expect(within(group).getByRole('textbox', { name: 'Item 1' })).toHaveValue('x');
  expect(within(list).queryByText(/Field name: "Item/u)).toBeNull();
  expect(within(group).getByText('Field name: "Item\\u00201"')).toBeVisible();
});
