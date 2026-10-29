import { createNixClient, type NixClient } from '@nix/api-client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyInput } from '../../collections/properties/property-input';
import { fieldChoices } from '../../collections/properties/use-field-choices';
import { item as stubItem, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { STUB_WORKSPACE_ID, type StubItem } from '@nix/web-foundation/testing/api-stub';

const state = vi.hoisted(() => ({ client: null as NixClient | null }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useOptionalApiClient: () => state.client,
}));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useOptionalWorkspace: () => ({ workspaceId: STUB_WORKSPACE_ID }),
}));

let nextId = 1;
function item(overrides: Partial<StubItem> = {}): StubItem {
  return stubItem({
    id: `aaaaaaaa-1111-4111-8111-${String(nextId++).padStart(12, '0')}`,
    title: 'Entry',
    ...overrides,
  });
}

const parent = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const property = {
  key: 'who',
  label: 'Who offended you',
  type: 'text',
  options: [],
  required: false,
  choiceSource: { itemId: null, field: 'who' },
};

beforeEach(() => {
  state.client = createNixClient({
    baseUrl: location.origin,
    tokens: {
      getAccessToken: () => Promise.resolve('test-token'),
      refreshAccessToken: () => Promise.resolve('test-token'),
    },
  });
});

describe('dynamic field suggestions', () => {
  it('deduplicates text values and flattens multi-selects without stringifying other types', () => {
    expect(
      fieldChoices(
        [
          item({ properties: { who: ['Alex', 'Sam', 'Alex'] } }),
          item({ properties: { who: 'Sam' } }),
          item({ properties: { who: 5 } }),
          item({ properties: { who: '' } }),
        ],
        'who',
      ),
    ).toEqual(['Alex', 'Sam']);
  });

  it('loads sibling values on focus and still accepts a new name', async () => {
    stubCoreApi({
      items: [
        item({ id: parent, hasChildren: true }),
        item({ parentId: parent, properties: { who: 'Alex' } }),
        item({
          id: '33333333-3333-4333-8333-333333333333',
          parentId: parent,
          properties: { who: 'Sam' },
        }),
      ],
    });
    const commit = vi.fn();
    render(
      <PropertyInput
        item={{ title: 'New grudge', parentId: parent, properties: {} }}
        property={property}
        onCommit={commit}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Who offended you' });
    fireEvent.focus(input);
    await waitFor(() => {
      expect(document.querySelectorAll('datalist option')).toHaveLength(2);
    });
    expect(
      [...document.querySelectorAll('datalist option')].map((option) =>
        option.getAttribute('value'),
      ),
    ).toEqual(['Alex', 'Sam']);
    fireEvent.change(input, { target: { value: 'Jordan' } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith('Jordan');
  });

  it('sources child titles from another note and preserves selected values no longer in the source', async () => {
    stubCoreApi({
      items: [item({ id: other, hasChildren: true }), item({ parentId: other, title: 'Alex' })],
    });
    const commit = vi.fn();
    render(
      <PropertyInput
        item={{ title: 'Grudge', parentId: parent, properties: { who: ['Former person'] } }}
        property={{
          ...property,
          type: 'multi_select',
          choiceSource: { itemId: other, field: 'title' },
        }}
        onCommit={commit}
      />,
    );
    fireEvent.focus(screen.getByRole('textbox', { name: 'New value for Who offended you' }));
    expect(await screen.findByRole('checkbox', { name: 'Alex' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Former person' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New value for Who offended you' }), {
      target: { value: 'Jordan' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(commit).toHaveBeenLastCalledWith(['Former person', 'Alex', 'Jordan']);
  });
});

it('waits for two entries and refreshes suggestions after a source write', async () => {
  const root = item({ id: parent, hasChildren: true });
  const first = item({ parentId: parent, properties: { who: 'Alex' } });
  stubCoreApi({ items: [root, first] });
  render(
    <PropertyInput
      item={{ title: 'Draft', parentId: parent, properties: {} }}
      property={property}
      onCommit={vi.fn()}
    />,
  );
  fireEvent.focus(screen.getByRole('combobox', { name: 'Who offended you' }));
  expect(await screen.findByText(/Suggestions appear after two saved entries/)).toBeInTheDocument();
  expect(document.querySelectorAll('datalist option')).toHaveLength(0);
  stubCoreApi({ items: [root, first, item({ parentId: parent, properties: { who: 'Sam' } })] });
  act(() => state.client?.invalidate(['items']));
  await waitFor(() => {
    expect(document.querySelectorAll('datalist option')).toHaveLength(2);
  });
});

it('keeps manual entry usable when the source cannot be read', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Not found',
            status: 404,
            code: 'item.not_found',
          }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        ),
      ),
    ),
  );
  const commit = vi.fn();
  render(
    <PropertyInput
      item={{ title: 'Draft', properties: {} }}
      property={{ ...property, choiceSource: { itemId: other, field: 'who' } }}
      onCommit={commit}
    />,
  );
  const input = screen.getByRole('combobox', { name: 'Who offended you' });
  fireEvent.focus(input);
  expect(await screen.findByText(/Suggestions could not be loaded/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: 'Jordan' } });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledWith('Jordan');
});
