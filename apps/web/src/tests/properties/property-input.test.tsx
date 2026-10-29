import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Item } from '../../collections/core/container-model';
import { PropertyInput } from '../../collections/properties/property-input';
import {
  useWorkspaceMembers,
  type WorkspaceMember,
  type WorkspaceMembersState,
} from '@nix/web-settings/settings/members/use-workspace-members';
import { propertyOf } from '../property-fixture';

// A date-or-time property is read and written in the reader's own zone, so it needs one fixed for
// the round trip to be predictable - the same reason collated-calendar.test.tsx fixes one.
process.env.TZ = 'Pacific/Honolulu';

/**
 * The hook is mocked at the module boundary rather than driven through a real fetch: everything
 * this file needs to assert is how `PropertyInput` renders each of the hook's states, not how the
 * hook itself reaches them - that read is `use-workspace-members.ts`'s own concern and is exercised
 * end to end by `members-section.test.tsx`.
 */
vi.mock('@nix/web-settings/settings/members/use-workspace-members', () => ({
  useWorkspaceMembers: vi.fn(),
}));

/**
 * One control per property type.
 *
 * Two of these assertions are the reason this component exists at all. The date one: a date
 * property carries no time and no zone, so the text that arrives has to be the text that goes back
 * - a field that made a Date out of it would hand back the day before for half the world. And the
 * unknown-type one: the contract calls a property type a string on purpose, so meeting one this
 * build has never heard of has to show the value rather than swallow it.
 */

function itemWith(properties: Record<string, unknown>): Item {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    parentId: '33333333-3333-4333-8333-333333333333',
    type: 'note',
    title: 'Kickoff',
    hasChildren: false,
    seq: 1,
    lifecycleState: 'active',
    properties,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('a property input', () => {
  it('gives a text property a text box', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toHaveValue('Ada');
  });

  it('gives a number property a number box, and stores a number rather than its text', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'points', label: 'Points', type: 'number' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByRole('spinbutton', { name: 'Points' }), '8');
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(8);
  });

  it('keeps the stored number when the box holds text it cannot parse, and says so', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ points: 5 })}
        property={propertyOf({ key: 'points', label: 'Points', type: 'number' })}
        onCommit={onCommit}
      />,
    );

    const box = screen.getByRole('spinbutton', { name: 'Points' });
    await person.click(box);
    // A number box reports '' for "3e" and flags it through validity.badInput.
    Object.defineProperty(box, 'validity', { value: { badInput: true }, configurable: true });
    fireEvent.change(box, { target: { value: '' } });
    await person.tab();

    expect(onCommit).not.toHaveBeenCalled();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('Enter a number.');
  });

  it('drops the number complaint once the box no longer holds unparseable text', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ points: 5 })}
        property={propertyOf({ key: 'points', label: 'Points', type: 'number' })}
        onCommit={onCommit}
      />,
    );

    const box = screen.getByRole('spinbutton', { name: 'Points' });
    await person.click(box);
    Object.defineProperty(box, 'validity', { value: { badInput: true }, configurable: true });
    fireEvent.change(box, { target: { value: '' } });
    await person.tab();
    expect(box).toHaveAttribute('aria-invalid', 'true');

    // Select all and delete: the box is empty and valid, and no change event fires.
    Object.defineProperty(box, 'validity', { value: { badInput: false }, configurable: true });
    await person.click(box);
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(null);
    expect(box).not.toHaveAttribute('aria-invalid', 'true');
  });

  it('does not flip a timed event to all-day while the time is half cleared', () => {
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ starts: '2026-03-17T09:00:00-10:00[Pacific/Honolulu]' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={onCommit}
      />,
    );

    const time = screen.getByLabelText('Time');
    fireEvent.change(time, { target: { value: '' } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(time);
    expect(onCommit).toHaveBeenCalledWith('2026-03-17');
  });

  it('still clears a number when the box is emptied on purpose', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ points: 5 })}
        property={propertyOf({ key: 'points', label: 'Points', type: 'number' })}
        onCommit={onCommit}
      />,
    );

    await person.clear(screen.getByRole('spinbutton', { name: 'Points' }));
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('gives a url property a url box', () => {
    render(
      <PropertyInput
        item={itemWith({ source: 'https://example.test/spec' })}
        property={propertyOf({ key: 'source', label: 'Source', type: 'url' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Source' })).toHaveAttribute('type', 'url');
  });

  it('gives a checkbox property a checkbox, and stores true or false', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ shipped: false })}
        property={propertyOf({ key: 'shipped', label: 'Shipped', type: 'checkbox' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Shipped' }));

    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('offers a select exactly the options the property declares, and a way back to none', () => {
    render(
      <PropertyInput
        item={itemWith({ status: 'Doing' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Doing', 'Done'],
        })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Status' });

    // Exactly the declared options. Inventing one would offer a value the schema refuses, and
    // dropping one would hide a value somebody is entitled to choose.
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Unset', 'Todo', 'Doing', 'Done']);
    expect(control).toHaveValue('Doing');
  });

  it('still offers the value an item holds when the schema no longer declares it', () => {
    render(
      <PropertyInput
        item={itemWith({ status: 'Blocked' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Done'],
        })}
        onCommit={vi.fn()}
      />,
    );

    // Otherwise the control reports some other option as the current one, which is a lie about the
    // item rather than a gap in the schema.
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('Blocked');
  });

  it('clears a select back to nothing rather than leaving a mistake permanent', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ status: 'Doing' })}
        property={propertyOf({
          key: 'status',
          label: 'Status',
          type: 'select',
          options: ['Todo', 'Doing'],
        })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Status' }), '');

    // Null, because that is what the contract's merge reads as "clear this one".
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('clears a text property by emptying it', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.clear(screen.getByRole('textbox', { name: 'Owner' }));
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('gives a multi-select a checkbox per option and stores the list', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review'],
        })}
        onCommit={onCommit}
      />,
    );

    const group = screen.getByRole('group', { name: 'Tags' });
    expect(within(group).getByRole('checkbox', { name: 'Draft' })).toBeChecked();

    await person.click(within(group).getByRole('checkbox', { name: 'Review' }));

    expect(onCommit).toHaveBeenCalledWith(['Draft', 'Review']);
  });

  it('clears a multi-select when its last option is unticked', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review'],
        })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Draft' }));

    // Nothing selected and no value are the same fact, and the contract already has a way to say it.
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('carries both choices when two multi-select boxes are tapped before either write returns', () => {
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review', 'Archived'],
        })}
        onCommit={onCommit}
      />,
    );

    const group = screen.getByRole('group', { name: 'Tags' });

    // Two taps close together, before the item prop has any chance to reflect the first one -
    // exactly the shape of the bug this guards. Firing both `click` events without awaiting a
    // render between them means each box's `onChange` reads whatever the previous one just set,
    // not the item's original value, if the fix is in place.
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Review' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Archived' }));

    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(1, ['Draft', 'Review']);
    // The second tap's write is the one that lands last, so it is the one that has to carry every
    // choice made so far - dropping the first tap here is exactly what shipped broken.
    expect(onCommit).toHaveBeenNthCalledWith(2, ['Draft', 'Review', 'Archived']);
  });

  it('selects a focused multi-select option with Enter', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ tags: ['Draft'] })}
        property={propertyOf({
          key: 'tags',
          label: 'Tags',
          type: 'multi_select',
          options: ['Draft', 'Review'],
        })}
        onCommit={onCommit}
      />,
    );

    const review = screen.getByRole('checkbox', { name: 'Review' });
    review.focus();
    await person.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledWith(['Draft', 'Review']);
  });

  it('round-trips a date as the text it was stored as, with no zone in the way', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ due: '2026-03-03' })}
        property={propertyOf({ key: 'due', label: 'Due', type: 'date' })}
        onCommit={onCommit}
      />,
    );

    const control = screen.getByLabelText('Due');

    // The stored text, unchanged. A field that made a Date of it would show the 2nd to anybody west
    // of Greenwich, which is the whole reason the value carries no time and no zone.
    expect(control).toHaveValue('2026-03-03');

    await person.clear(control);
    await person.type(control, '2026-12-31');
    await person.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('2026-12-31');
  });

  it('leaves a stored value that is not a date alone rather than offering to overwrite it', () => {
    render(
      <PropertyInput
        item={itemWith({ due: 'next Tuesday' })}
        property={propertyOf({ key: 'due', label: 'Due', type: 'date' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('textbox', { name: 'Due' });
    expect(control).toHaveValue('next Tuesday');
    expect(control).toHaveAttribute('readonly');
    expect(screen.getByText(/is not a date this field can show/)).toBeVisible();
  });

  it('shows a date-or-time property holding a bare date as all-day, with no time filled in', () => {
    render(
      <PropertyInput
        item={itemWith({ starts: '2026-03-17' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Date')).toHaveValue('2026-03-17');
    expect(screen.getByLabelText('Time')).toHaveValue('');
  });

  it('shows a date-or-time property holding a moment as its date and time in the reader zone', () => {
    render(
      <PropertyInput
        item={itemWith({ starts: '2026-03-17T09:00:00-10:00[Pacific/Honolulu]' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Date')).toHaveValue('2026-03-17');
    expect(screen.getByLabelText('Time')).toHaveValue('09:00');
  });

  it('commits a bare date when no time is given, exactly as a date property would', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByLabelText('Date'), '2026-03-17');

    expect(onCommit).toHaveBeenCalledWith('2026-03-17');
  });

  it('commits an RFC 9557 timestamp, in the reader zone, once a time is given', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ starts: '2026-03-17' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByLabelText('Time'), '0900AM');

    expect(onCommit).toHaveBeenCalledWith('2026-03-17T09:00:00-10:00[Pacific/Honolulu]');
  });

  it('returns a timed value to all-day when the time is cleared', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ starts: '2026-03-17T09:00:00-10:00[Pacific/Honolulu]' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={onCommit}
      />,
    );

    await person.clear(screen.getByLabelText('Time'));
    await person.tab();

    expect(onCommit).toHaveBeenCalledWith('2026-03-17');
  });

  it('leaves a stored value that is neither a date nor a time alone rather than offering to overwrite it', () => {
    render(
      <PropertyInput
        item={itemWith({ starts: 'next Tuesday' })}
        property={propertyOf({ key: 'starts', label: 'Starts', type: 'datetime' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('textbox', { name: 'Starts' });
    expect(control).toHaveValue('next Tuesday');
    expect(control).toHaveAttribute('readonly');
    expect(screen.getByText(/is not a date or a time this field can show/)).toBeVisible();
  });

  it('shows a type it does not know as the value that is stored, read-only, and says so', () => {
    render(
      <PropertyInput
        item={itemWith({ rating: 4 })}
        property={propertyOf({ key: 'rating', label: 'Rating', type: 'stars' })}
        onCommit={vi.fn()}
      />,
    );

    // Property types are an open set by contract. Rendering nothing for one would hide a value
    // somebody stored behind a build that has not caught up.
    const control = screen.getByRole('textbox', { name: 'Rating' });
    expect(control).toHaveValue('4');
    expect(control).toHaveAttribute('readonly');
    expect(screen.getByText(/does not know the "stars" property type/)).toBeVisible();
  });

  it('marks a required property required', () => {
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', required: true })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toBeRequired();
  });

  it('does not write while somebody is typing', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.type(screen.getByRole('textbox', { name: 'Owner' }), 'Ada');

    // A request per keystroke is four requests to store one name, three of which store a value
    // nobody meant.
    expect(onCommit).not.toHaveBeenCalled();

    await person.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Ada');
  });

  it('does not write when a field is left exactly as it was found', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('textbox', { name: 'Owner' }));
    await person.tab();

    // Otherwise tabbing through the panel writes every property on the way past.
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('shows a refusal against the control it belongs to', () => {
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        error="'owner' is required."
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent("'owner' is required.");
    expect(screen.getByRole('textbox', { name: 'Owner' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders at cell density without a second border', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        density="cell"
      />,
    );

    // The column header is the label, so the control names itself after its row instead - and the
    // cell already has a rule under it, so a framed box inside it would read as a double rule.
    const control = screen.getByRole('textbox', { name: 'Owner for Kickoff' });
    expect(control).toHaveClass('border-transparent');
    expect(screen.queryByText('Owner')).not.toBeInTheDocument();
  });

  it('does not offer to write anything when writing is not permitted', () => {
    render(
      <PropertyInput
        item={itemWith({ owner: 'Ada' })}
        property={propertyOf({ key: 'owner', label: 'Owner' })}
        onCommit={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Owner' })).toBeDisabled();
  });

  it('edits a due date and a start date through the same day-only control a date gets', () => {
    // The task types refine meaning, never representation: the text that arrives is the text that
    // goes back, exactly as the plain date test above establishes.
    render(
      <>
        <PropertyInput
          item={itemWith({ due_date: '2026-09-01' })}
          property={propertyOf({ key: 'due_date', label: 'Due', type: 'due_date' })}
          onCommit={vi.fn()}
        />
        <PropertyInput
          item={itemWith({ start_date: '2026-08-25' })}
          property={propertyOf({ key: 'start_date', label: 'Begins', type: 'start_date' })}
          onCommit={vi.fn()}
        />
      </>,
    );

    expect(screen.getByLabelText('Due')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('Begins')).toHaveValue('2026-08-25');
  });

  it('edits completion as a checkbox that stores true or false', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ completion: false })}
        property={propertyOf({ key: 'completion', label: 'Done', type: 'completion' })}
        onCommit={onCommit}
      />,
    );

    await person.click(screen.getByRole('checkbox', { name: 'Done' }));

    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it('offers priority as the closed four-step scale, storing the number', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({ priority: 3 })}
        property={propertyOf({ key: 'priority', label: 'Urgency', type: 'priority' })}
        onCommit={onCommit}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Urgency' });
    const options = within(control).getAllByRole('option');
    // Four levels plus the way back to none; chosen, never typed, so the 0 and the 7 the server
    // refuses are not offerable here.
    expect(options).toHaveLength(5);

    await person.selectOptions(control, '1');
    expect(onCommit).toHaveBeenCalledWith(1);
  });

  it('edits an estimate as a number, storing a number rather than its text', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'estimate', label: 'Hours', type: 'estimate' })}
        onCommit={onCommit}
      />,
    );

    const box = screen.getByRole('spinbutton', { name: 'Hours' });
    await person.type(box, '2.5');
    await person.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalledWith(2.5);
  });
});

describe('an assignee property', () => {
  const ada: WorkspaceMember = {
    subjectType: 'principal',
    subjectId: '44444444-bbbb-4bbb-8bbb-444444444444',
    subjectDisplayName: 'Ada Lovelace',
    email: 'ada@example.test',
    role: 'owner',
    grantedAt: '2026-01-05T09:00:00+00:00',
    canChangeRole: false,
    canRemove: false,
    assignableRoles: [],
  };

  const grace: WorkspaceMember = {
    subjectType: 'principal',
    subjectId: '55555555-bbbb-4bbb-8bbb-555555555555',
    subjectDisplayName: 'Grace Hopper',
    email: 'grace@example.test',
    role: 'editor',
    grantedAt: '2026-03-12T09:00:00+00:00',
    canChangeRole: false,
    canRemove: false,
    assignableRoles: [],
  };

  function membersState(overrides: Partial<WorkspaceMembersState> = {}): WorkspaceMembersState {
    return {
      status: 'ready',
      members: [],
      truncated: false,
      error: null,
      reload: vi.fn(),
      ...overrides,
    };
  }

  it('offers the workspace members and a way back to unassigned', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada, grace] }));

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Owner' });

    // The same word a plain select clears through, not a second one invented for people.
    expect(
      within(control)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Unset', 'Ada Lovelace', 'Grace Hopper']);
    expect(control).toHaveValue(ada.subjectId);
  });

  it("commits the chosen person's identifier, not their name", async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada, grace] }));

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'Grace Hopper');

    expect(onCommit).toHaveBeenCalledWith(grace.subjectId);
  });

  it('clears back to unassigned rather than leaving a mistake permanent', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada] }));

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={onCommit}
      />,
    );

    await person.selectOptions(screen.getByRole('combobox', { name: 'Owner' }), 'Unset');

    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('says it is loading rather than showing an empty list that looks like nobody is here', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ status: 'loading' }));

    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText(/loading the workspace members/i)).toBeVisible();
  });

  it('says a failed member read failed, and still shows what is stored', () => {
    vi.mocked(useWorkspaceMembers).mockReturnValue(
      membersState({ status: 'error', error: 'Core could not be reached.' }),
    );

    render(
      <PropertyInput
        item={itemWith({ owner: ada.subjectId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    // The read failing is not a reason to also hide what the item holds.
    expect(screen.getByText(/core could not be reached/i)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Owner' })).toHaveValue(ada.subjectId);
  });

  it('shows an identifier the member list does not carry as the current value, not dropped or mislabelled', () => {
    const strangerId = '99999999-bbbb-4bbb-8bbb-999999999999';
    vi.mocked(useWorkspaceMembers).mockReturnValue(membersState({ members: [ada] }));

    render(
      <PropertyInput
        item={itemWith({ owner: strangerId })}
        property={propertyOf({ key: 'owner', label: 'Owner', type: 'assignee' })}
        onCommit={vi.fn()}
      />,
    );

    const control = screen.getByRole('combobox', { name: 'Owner' });

    // Neither dropped (the value stays selected, not "Unset") nor mislabelled (its own identifier,
    // never Ada's name) - the honest answer when the list cannot vouch for who this is.
    expect(control).toHaveValue(strangerId);
    expect(within(control).getByRole('option', { name: strangerId })).toBeInTheDocument();
  });
});

describe('a formula property', () => {
  const formula = propertyOf({
    key: 'total',
    label: 'Total',
    type: 'formula',
    expression: '[price] * 2',
  });

  it('shows the computed value as a result rather than as a box to type in', () => {
    render(<PropertyInput item={itemWith({ total: 50 })} property={formula} onCommit={vi.fn()} />);

    expect(screen.getByRole('status', { name: 'Total' })).toHaveTextContent('50');
    expect(screen.queryByRole('textbox', { name: 'Total' })).not.toBeInTheDocument();
  });

  it('says where the value comes from', () => {
    render(<PropertyInput item={itemWith({ total: 50 })} property={formula} onCommit={vi.fn()} />);

    expect(
      screen.getByText(/Computed from this item.s other properties: \[price\] \* 2/),
    ).toBeVisible();
  });

  it('explains an error code instead of showing it as though it were a value', () => {
    // A bare #NAME? in a field called Total reads as a value to somebody who has never used a
    // spreadsheet. The sentence is the property surface's own, not the grid's: three of the grid's
    // are about cells and sheets, and there are none here.
    render(
      <PropertyInput item={itemWith({ total: '#NAME?' })} property={formula} onCommit={vi.fn()} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      '#NAME? - This formula uses a property name that nothing here declares, or an unknown function.',
    );
  });

  it('leaves the explanation out of a table cell, where the column header says it once', () => {
    // A hint in a cell prints under every row and grows every one of them to repeat what a header
    // could say once. The code itself is still the value, which is what a spreadsheet shows too.
    render(
      <PropertyInput
        item={itemWith({ total: '#DIV/0!' })}
        property={formula}
        onCommit={vi.fn()}
        density="cell"
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('#DIV/0!');
    expect(screen.queryByText(/divides by zero/)).not.toBeInTheDocument();
  });
});

describe('a rollup property', () => {
  it('shows the folded value as a result rather than as a box to type in', () => {
    render(
      <PropertyInput
        item={itemWith({ tasks: 12 })}
        property={propertyOf({
          key: 'tasks',
          label: 'Tasks',
          type: 'rollup',
          aggregate: 'count',
          source: null,
        })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByRole('status', { name: 'Tasks' })).toHaveTextContent('12');
    expect(screen.queryByRole('textbox', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('says the value is about the items inside this one, not about this one', () => {
    // A formula is about this item and a rollup is about its children. Somebody reading a number
    // they cannot edit needs to know which.
    render(
      <PropertyInput
        item={itemWith({ hours: 40 })}
        property={propertyOf({
          key: 'hours',
          label: 'Hours',
          type: 'rollup',
          aggregate: 'sum',
          source: 'estimate',
        })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText(/Total of "estimate" across the items inside this one/)).toBeVisible();
  });

  it('names a count of the children without naming a property', () => {
    render(
      <PropertyInput
        item={itemWith({ tasks: 3 })}
        property={propertyOf({
          key: 'tasks',
          label: 'Tasks',
          type: 'rollup',
          aggregate: 'count',
          source: null,
        })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText(/How many of the items inside this one/)).toBeVisible();
  });

  it('writes a reminder as an RFC 9557 moment in the reader’s zone, which is what Core accepts', () => {
    const onCommit = vi.fn();
    render(
      <PropertyInput
        item={itemWith({})}
        property={propertyOf({ key: 'reminder', label: 'Reminder', type: 'reminder' })}
        onCommit={onCommit}
      />,
    );

    const control = screen.getByLabelText('Date and time');
    fireEvent.change(control, { target: { value: '2099-03-17T09:30' } });
    fireEvent.blur(control);

    expect(onCommit).toHaveBeenCalledWith('2099-03-17T09:30:00-10:00[Pacific/Honolulu]');
    expect(screen.getByText(/in Pacific\/Honolulu/)).toBeVisible();
  });

  it('keeps an unsent timestamp and its time zone through refresh, then saves it on blur', () => {
    const onCommit = vi.fn();
    const property = propertyOf({ key: 'starts', label: 'Starts', type: 'timestamp' });
    const { rerender } = render(
      <PropertyInput
        item={itemWith({ starts: '2099-03-17T09:30:00+00:00[Europe/London]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    const control = screen.getByLabelText('Date and time');
    fireEvent.change(control, { target: { value: '2099-03-17T10:45' } });
    rerender(
      <PropertyInput
        item={itemWith({ starts: '2099-03-18T14:00:00-04:00[America/New_York]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    expect(control).toHaveValue('2099-03-17T10:45');
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Europe/London');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(control);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('2099-03-17T10:45:00+00:00[Europe/London]');

    rerender(
      <PropertyInput
        item={itemWith({ starts: '2099-03-19T16:15:00+01:00[Europe/Berlin]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    expect(control).toHaveValue('2099-03-19T16:15');
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Europe/Berlin');
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsent reminder through refresh, then saves it on blur', () => {
    const onCommit = vi.fn();
    const property = propertyOf({ key: 'reminder', label: 'Reminder', type: 'reminder' });
    const { rerender } = render(
      <PropertyInput
        item={itemWith({ reminder: '2099-03-17T19:30:00+00:00[Europe/London]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    const control = screen.getByLabelText('Date and time');
    fireEvent.change(control, { target: { value: '2099-03-17T10:45' } });
    rerender(
      <PropertyInput
        item={itemWith({ reminder: '2099-03-18T18:00:00+00:00[Europe/London]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    expect(control).toHaveValue('2099-03-17T10:45');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(control);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('2099-03-17T10:45:00-10:00[Pacific/Honolulu]');

    rerender(
      <PropertyInput
        item={itemWith({ reminder: '2099-03-19T22:15:00+00:00[Europe/London]' })}
        property={property}
        onCommit={onCommit}
      />,
    );
    expect(control).toHaveValue('2099-03-19T12:15');
    fireEvent.blur(control);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      type: 'timestamp',
      initial: '2099-03-17T09:30:00+00:00[Europe/London]',
      expected: '2099-03-17T10:45:00+00:00[Europe/London]',
    },
    {
      type: 'reminder',
      initial: '2099-03-17T19:30:00+00:00[Europe/London]',
      expected: '2099-03-17T10:45:00-10:00[Pacific/Honolulu]',
    },
  ])(
    'retries an unchanged $type draft on blur after a failed save',
    ({ type, initial, expected }) => {
      const onCommit = vi.fn();
      const property = propertyOf({ key: 'moment', label: 'Moment', type });
      const stored = itemWith({ moment: initial });
      const { rerender } = render(
        <PropertyInput item={stored} property={property} onCommit={onCommit} />,
      );
      const control = screen.getByLabelText('Date and time');
      fireEvent.change(control, { target: { value: '2099-03-17T10:45' } });
      fireEvent.blur(control);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);

      rerender(
        <PropertyInput
          item={stored}
          property={property}
          error="That change could not be saved."
          onCommit={onCommit}
        />,
      );
      expect(control).toHaveValue('2099-03-17T10:45');
      expect(screen.getByRole('alert')).toHaveTextContent('That change could not be saved.');
      fireEvent.blur(control);
      expect(onCommit.mock.calls).toEqual([[expected], [expected]]);
    },
  );

  it('shows a stored reminder on the reader’s own clock and clears it with its own control', async () => {
    const person = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <PropertyInput
        item={itemWith({ reminder: '2099-03-17T19:30:00+00:00[Europe/London]' })}
        property={propertyOf({ key: 'reminder', label: 'Reminder', type: 'reminder' })}
        onCommit={onCommit}
      />,
    );

    expect(screen.getByLabelText('Date and time')).toHaveValue('2099-03-17T09:30');
    await person.click(screen.getByRole('button', { name: 'Clear Reminder' }));
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('says when a reminder’s time has already passed', () => {
    render(
      <PropertyInput
        item={itemWith({ reminder: '2020-01-01T09:00:00-10:00[Pacific/Honolulu]' })}
        property={propertyOf({ key: 'reminder', label: 'Reminder', type: 'reminder' })}
        onCommit={vi.fn()}
      />,
    );

    expect(screen.getByText(/This time has passed/)).toBeVisible();
  });
});

describe('long text edits', () => {
  it('keeps Enter as a newline, commits once on blur, and caps the field at 8000', async () => {
    const onCommit = vi.fn();
    const person = userEvent.setup();
    render(
      <PropertyInput
        item={itemWith({ notes: 'First' })}
        property={propertyOf({ key: 'notes', label: 'Notes', type: 'long_text' })}
        onCommit={onCommit}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Notes' });
    expect(field).toHaveAttribute('maxlength', '8000');
    await person.click(field);
    await person.type(field, '{End}{Enter}Second');
    expect(onCommit).not.toHaveBeenCalled();
    await person.tab();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('First\nSecond');
  });
  it('discards an unfinished edit on Escape and renders three lines on a card', async () => {
    const onCommit = vi.fn();
    const person = userEvent.setup();
    render(
      <PropertyInput
        item={itemWith({ notes: 'First' })}
        property={propertyOf({ key: 'notes', type: 'long_text' })}
        density="card"
        onCommit={onCommit}
      />,
    );
    const field = screen.getByRole('textbox');
    expect(field).toHaveAttribute('rows', '3');
    await person.click(field);
    await person.type(field, ' changed{Escape}');
    await person.tab();
    expect(field).toHaveValue('First');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('edits a one-line text that holds line breaks as several lines, keeping them', async () => {
    const onCommit = vi.fn();
    const person = userEvent.setup();
    render(
      <PropertyInput
        item={itemWith({ summary: 'First\nSecond' })}
        property={propertyOf({ key: 'summary', label: 'Summary', type: 'text' })}
        onCommit={onCommit}
      />,
    );
    const field = screen.getByRole('textbox', { name: 'Summary' });
    expect(field.tagName).toBe('TEXTAREA');
    await person.click(field);
    await person.type(field, '{End}!');
    await person.tab();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('First\nSecond!');
  });
});

it('keeps a scalar value visible after changing a text field to multi-select', () => {
  const onCommit = vi.fn();
  render(
    <PropertyInput
      item={itemWith({ who: 'Alex' })}
      property={propertyOf({ key: 'who', label: 'Who', type: 'multi_select', options: ['Sam'] })}
      onCommit={onCommit}
    />,
  );
  expect(screen.getByRole('checkbox', { name: 'Alex' })).toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Sam' }));
  expect(onCommit).toHaveBeenCalledWith(['Alex', 'Sam']);
});
