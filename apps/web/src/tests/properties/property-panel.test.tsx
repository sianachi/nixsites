import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../render-with-router';
import type { Item } from '../../views/core/container-model';
import { PropertyPanel } from '../../properties/property-panel';
import { propertyOf } from '../property-fixture';

/**
 * An item's properties, editable from the item.
 *
 * This closes a hole rather than polishing one: MVP-2 gave folders schemas and gave items values,
 * and left no way to set a value from the item that has it. The only route was dragging a card on
 * a board, which writes exactly one property - so a note with an owner and a due date could have
 * neither set without a board configured for each.
 */

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
    workspaceId: 'w1',
    parentId: null,
    type: 'note',
    title: 'Roadmap',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-07-27T00:00:00Z',
    updatedAt: '2026-07-27T00:00:00Z',
  };
}

describe('the property panel', () => {
  it('keeps required, computed, false and zero values visible while revealing optional empty fields on demand', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(() => Promise.resolve(null));
    renderAt(
      <PropertyPanel
        compact
        item={itemWith({ count: 0, enabled: false, owner: '' })}
        properties={[
          propertyOf({ key: 'count', label: 'Count', type: 'number' }),
          propertyOf({ key: 'enabled', label: 'Enabled', type: 'checkbox' }),
          propertyOf({ key: 'required', label: 'Required value', required: true }),
          propertyOf({ key: 'total', label: 'Total', type: 'formula', expression: '1 + 1' }),
          propertyOf({ key: 'owner', label: 'Owner' }),
        ]}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText('Count')).toHaveValue(0);
    expect(screen.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked();
    expect(screen.getByLabelText(/Required value/)).toBeRequired();
    expect(screen.getByText('Total')).toBeVisible();
    expect(screen.queryByLabelText('Owner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More details (1)' }));
    expect(screen.getByLabelText('Owner')).toHaveFocus();
    await user.type(screen.getByLabelText('Owner'), 'Ada');
    await user.tab();
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ owner: 'Ada' });
    });
  });
  it('offers every property the schema puts in force', () => {
    renderAt(
      <PropertyPanel
        item={itemWith({ status: 'Doing' })}
        properties={[
          propertyOf({
            key: 'status',
            label: 'Status',
            type: 'select',
            options: ['Todo', 'Doing'],
          }),
          propertyOf({ key: 'owner', label: 'Owner' }),
        ]}
        onChange={() => Promise.resolve(null)}
      />,
    );

    expect(screen.getByLabelText('Status')).toBeVisible();
    expect(screen.getByLabelText('Owner')).toBeVisible();
  });

  it('does not offer to edit the title', () => {
    renderAt(
      <PropertyPanel
        item={itemWith({ title: 'Roadmap' })}
        properties={[propertyOf({ key: 'title', label: 'Title' })]}
        onChange={() => Promise.resolve(null)}
      />,
    );

    // The rename path owns it. A second control for one field is two ways to write it, and they
    // disagree the first time one loses a race - which is why the server refuses to have it
    // redeclared too.
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });

  it('says where properties come from when there are none', () => {
    renderAt(
      <PropertyPanel item={itemWith({})} properties={[]} onChange={() => Promise.resolve(null)} />,
    );

    // "No properties" on its own reads as a fault. Naming where they come from is what makes it
    // read as nothing having declared any yet - and says where to go to change that.
    expect(screen.getByText(/properties come from/i)).toBeVisible();
  });

  it('distinguishes not knowing yet from knowing there are none', () => {
    renderAt(
      <PropertyPanel
        item={itemWith({})}
        properties={[]}
        onChange={() => Promise.resolve(null)}
        loading
      />,
    );

    expect(screen.queryByText(/has not declared/i)).not.toBeInTheDocument();
  });

  it('writes only the property that changed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(() => Promise.resolve(null));

    renderAt(
      <PropertyPanel
        item={itemWith({ status: 'Todo', owner: 'Ada' })}
        properties={[
          propertyOf({
            key: 'status',
            label: 'Status',
            type: 'select',
            options: ['Todo', 'Doing'],
          }),
          propertyOf({ key: 'owner', label: 'Owner' }),
        ]}
        onChange={onChange}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Status'), 'Doing');

    // The endpoint merges, so sending the whole bag would be sending values nobody touched - and
    // would overwrite a change somebody else made to one of them in between.
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ status: 'Doing' });
    });
  });

  it('shows the server s refusal against the property it names', async () => {
    const user = userEvent.setup();

    renderAt(
      <PropertyPanel
        item={itemWith({})}
        properties={[propertyOf({ key: 'owner', label: 'Owner' })]}
        onChange={() => Promise.resolve('Owner is required.')}
      />,
    );

    await user.type(screen.getByLabelText('Owner'), 'Ada');
    await user.tab();

    // Verbatim and beside the field. The server names the property at fault, and a refusal shown
    // somewhere else leaves somebody hunting for which of six fields it meant.
    expect(await screen.findByText('Owner is required.')).toBeVisible();
  });

  it('marks a required property required', () => {
    renderAt(
      <PropertyPanel
        item={itemWith({})}
        properties={[propertyOf({ key: 'owner', label: 'Owner', required: true })]}
        onChange={() => Promise.resolve(null)}
      />,
    );

    expect(screen.getByLabelText(/Owner/)).toBeRequired();
  });

  it('offers nothing to write when writing is not permitted', () => {
    renderAt(
      <PropertyPanel
        item={itemWith({ owner: 'Ada' })}
        properties={[propertyOf({ key: 'owner', label: 'Owner' })]}
        onChange={() => Promise.resolve(null)}
        disabled
      />,
    );

    // Shown rather than hidden: a reader still needs to see what the values are.
    expect(screen.getByLabelText('Owner')).toBeDisabled();
  });
});
