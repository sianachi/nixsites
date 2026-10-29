import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import { aView } from '../../view-fixture';
import { aContainer } from '../../container-fixture';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  View,
} from '../../../views/core/container-model';
import { ListView } from '../../../views/list/list-view';

/**
 * The grouped list (plan 3.3): a list view given a `groupBy` draws one section per value, each
 * with a heading, a count and a disclosure that folds it.
 */

function item(
  id: string,
  title: string,
  seq: number,
  properties: Record<string, unknown> = {},
  type = 'note',
): Item {
  return {
    id,
    workspaceId: 'workspace-1',
    parentId: 'folder-1',
    type,
    title,
    hasChildren: false,
    seq,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Open', 'Done'],
  required: false,
};
const DONE: PropertyDefinition = {
  key: 'done',
  label: 'Done',
  type: 'checkbox',
  options: [],
  required: false,
};
const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
};

const SCHEMA: EffectiveSchema = {
  properties: [STATUS, DONE, OWNER],
  declared: [STATUS, DONE, OWNER],
  inherit: true,
};

const CHILDREN = [
  item('a', 'Alpha', 1, { status: 'Done', done: true }),
  item('b', 'Bravo', 2, { status: 'Open' }),
  item('c', 'Charlie', 3, {}, 'canvas'),
  item('d', 'Delta', 4, { status: 'Open', done: false }),
];

function renderList(view: Partial<View>): ReturnType<typeof renderAt> {
  return renderAt(
    <ListView
      container={aContainer({ schema: SCHEMA, children: CHILDREN })}
      view={aView({ kind: 'list', columns: ['owner'], ...view })}
      onOpen={vi.fn()}
    />,
  );
}

/** The section headings, in order, as their buttons read. */
function sectionButtons(): string[] {
  return screen
    .getAllByRole('heading', { level: 3 })
    .map((heading) => within(heading).getByRole('button').textContent);
}

describe('a grouped list', () => {
  it('draws a section per select value in the declared order, the unset group last', () => {
    renderList({ groupBy: 'status' });

    expect(sectionButtons()).toEqual(['Open2 items', 'Done1 item', 'No status1 item']);
    const open = screen.getByRole('table', { name: 'Open' });
    expect(
      within(open)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Bravo', 'Delta']);
  });

  it('follows the view order when it names one', () => {
    renderList({ groupBy: 'status', groupOrder: ['Done', 'Open'] });

    expect(sectionButtons()).toEqual(['Done1 item', 'Open2 items', 'No status1 item']);
  });

  it('sections by a checkbox as two groups, unticked and never-set together', () => {
    renderList({ groupBy: 'done' });

    expect(sectionButtons()).toEqual(['Not done3 items', 'Done1 item']);
  });

  it('sections by the body kind of each item', () => {
    renderList({ groupBy: '$type' });

    expect(sectionButtons()).toEqual(['Note3 items', 'Canvas1 item']);
  });

  it('folds and unfolds a section from its heading, saying which state it is in', async () => {
    const user = userEvent.setup();
    renderList({ groupBy: 'status' });

    const toggle = screen.getByRole('button', { name: /^Open/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: 'Open' })).not.toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Done' })).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole('table', { name: 'Open' })).toBeInTheDocument();
  });

  it('opens with the sections the view stores as collapsed already folded', () => {
    renderList({ groupBy: 'status', collapsedGroups: [''] });

    expect(screen.getByRole('button', { name: /^No status/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('table', { name: 'No status' })).not.toBeInTheDocument();
  });

  it('keeps its rows and says why when the grouping property has gone', () => {
    renderList({ groupBy: 'priority' });

    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(screen.getByText(/This list is shown without sections/)).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader')).toHaveLength(4);
  });

  it('refuses a free-text grouping the same way, rather than a heading per value', () => {
    renderList({ groupBy: 'owner' });

    expect(screen.getByText(/only a select or a checkbox can make sections/)).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader')).toHaveLength(4);
  });
});
