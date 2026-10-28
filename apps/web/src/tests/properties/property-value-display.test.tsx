import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PropertyDefinition } from '../../views/core/container-model';
import { MemberDirectory } from '../../properties/member-directory';
import { PropertyValueDisplay } from '../../properties/property-value-display';
import {
  useWorkspaceMembers,
  type WorkspaceMembersState,
} from '@nix/web-settings/settings/members/use-workspace-members';

vi.mock('@nix/web-settings/settings/members/use-workspace-members', () => ({
  useWorkspaceMembers: vi.fn(),
}));

const MEMBER_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function membersAre(state: Partial<WorkspaceMembersState>): void {
  vi.mocked(useWorkspaceMembers).mockReturnValue({
    status: 'ready',
    members: [],
    truncated: false,
    error: null,
    reload: () => Promise.resolve(),
    ...state,
  });
}

function showAssignee() {
  return render(
    <MemberDirectory>
      <PropertyValueDisplay
        item={{ title: 'Item', properties: { field: MEMBER_ID } }}
        property={property('field', 'assignee')}
      />
    </MemberDirectory>,
  );
}

function property(key: string, type: string): PropertyDefinition {
  return {
    key,
    label: key,
    type,
    options: [],
    required: false,
    expression: null,
    aggregate: null,
    source: null,
  };
}

function show(type: string, value: unknown) {
  return render(
    <PropertyValueDisplay
      item={{ title: 'Item', properties: { field: value } }}
      property={property('field', type)}
    />,
  );
}

describe('a property value, read rather than edited', () => {
  it('draws nothing for an empty value, so a card has no blank labels', () => {
    const { container } = show('text', '');
    expect(container).toBeEmptyDOMElement();
  });

  it('never renders an editing control', () => {
    for (const [type, value] of [
      ['select', 'Doing'],
      ['multi_select', ['a', 'b']],
      ['checkbox', true],
      ['number', 3],
      ['priority', 2],
      ['date', '2026-03-04'],
    ] as const) {
      const { unmount } = show(type, value);
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows choices as tags and a priority by its word', () => {
    show('multi_select', ['Design', 'Q3']);
    expect(screen.getByText('Design')).toBeVisible();
    expect(screen.getByText('Q3')).toBeVisible();

    show('priority', 1);
    expect(screen.getByText('P1 Urgent')).toBeVisible();
  });

  it('reads a checkbox out in words, not as a glyph alone', () => {
    show('completion', true);
    expect(screen.getByText('field: yes')).toBeInTheDocument();
  });

  it('formats numbers and writes a stored day in words without shifting it', () => {
    show('estimate', 1234.5);
    expect(
      screen.getByText(
        new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1234.5),
      ),
    ).toBeVisible();

    show('date', '2026-03-04');
    // The reader's locale decides the words; the day must be the 4th wherever the reader sits.
    const expected = new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(Date.UTC(2026, 2, 4));
    expect(screen.getByText(expected)).toBeVisible();
  });

  it('says a past due date is overdue in words, in a glyph and in tone - never colour alone', () => {
    const { container } = show('due_date', '2000-01-01');
    expect(screen.getByText('(overdue)', { exact: false })).toBeInTheDocument();
    // The glyph is the sighted reader's cue; the words above are the screen reader's.
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('draws no overdue glyph on a due date still ahead', () => {
    const { container } = show('due_date', '2999-01-01');
    expect(screen.queryByText('(overdue)', { exact: false })).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('does not call an assignee unknown when no directory has been asked', () => {
    show('assignee', MEMBER_ID);
    expect(screen.queryByText('Unknown member')).not.toBeInTheDocument();
  });

  it('shows a link by its host, opening somewhere else', () => {
    show('url', 'https://example.com/a/very/long/path');
    const link = screen.getByRole('link', { name: 'example.com' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('an assignee, named from the member directory', () => {
  beforeEach(() => {
    vi.mocked(useWorkspaceMembers).mockReset();
  });

  it('names nobody while the members are still loading', () => {
    membersAre({ status: 'loading' });
    showAssignee();
    expect(screen.queryByText('Unknown member')).not.toBeInTheDocument();
  });

  it('names a member once the members have loaded', () => {
    membersAre({
      members: [
        {
          subjectId: MEMBER_ID,
          subjectDisplayName: 'Ada Lovelace',
        } as WorkspaceMembersState['members'][number],
      ],
    });
    showAssignee();
    expect(screen.getByText('Ada Lovelace')).toBeVisible();
  });

  it('says unknown member only once a successful load has not found them', () => {
    membersAre({ members: [] });
    showAssignee();
    expect(screen.getByText('Unknown member')).toBeVisible();
  });

  it('does not call an assignee unknown when the members could not be read', () => {
    membersAre({ status: 'error', error: 'Core could not be reached.' });
    showAssignee();
    expect(screen.queryByText('Unknown member')).not.toBeInTheDocument();
  });
});
