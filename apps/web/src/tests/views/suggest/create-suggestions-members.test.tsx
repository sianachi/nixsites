import type { NixClient } from '@nix/api-client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateItemControl } from '../../../views/core/create-item-control';
import type { PropertyDefinition } from '../../../views/core/container-model';
import { useViewSuggestionPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import { WORKSPACE_ID, anItem } from './suggest-fixtures';

/**
 * Naming the people a create field suggests: one member-list read for the whole field, however many
 * person lines it draws, and a name rather than an identifier once the list has arrived.
 */

const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../settings/members/use-workspace-members', () => ({
  useWorkspaceMembers: () => {
    useEffect(() => {
      reads.count += 1;
    }, []);
    return {
      status: 'ready',
      members: [
        { subjectId: 'person-ada', subjectDisplayName: 'Ada Lovelace' },
        { subjectId: 'person-bob', subjectDisplayName: 'Bob Builder' },
      ],
      truncated: false,
      error: null,
      reload: () => Promise.resolve(),
    };
  },
}));

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useOptionalWorkspace: () => ({ workspaceId: WORKSPACE_ID }),
}));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useOptionalApiClient: () =>
    ({
      query: () => Promise.resolve({ query: '', limit: 20, truncated: false, results: [] }),
    }) as unknown as NixClient,
}));

const OWNER: PropertyDefinition = {
  key: 'owner',
  label: 'Owner',
  type: 'assignee',
  options: [],
  required: false,
};

const REVIEWER: PropertyDefinition = {
  key: 'reviewer',
  label: 'Reviewer',
  type: 'assignee',
  options: [],
  required: false,
};

function children() {
  return [
    anItem('Invoice March', { owner: 'person-ada', reviewer: 'person-bob' }),
    anItem('Invoice April', { owner: 'person-ada', reviewer: 'person-bob' }),
    anItem('Invoice May', { owner: 'person-ada', reviewer: 'person-bob' }),
    anItem('Groceries', { owner: 'person-bob', reviewer: 'person-ada' }),
    anItem('Dry cleaning', { owner: 'person-bob', reviewer: 'person-ada' }),
    anItem('Library books', { owner: 'person-bob', reviewer: 'person-ada' }),
  ];
}

beforeEach(() => {
  reads.count = 0;
  useViewSuggestionPreference.getState().setSetting('on');
});

describe('people in create suggestions', () => {
  it('reads the member list once for every person line in the field', async () => {
    render(
      <CreateItemControl
        label="Add an item"
        onCreate={vi.fn()}
        suggest={{ children: children(), schema: [OWNER, REVIEWER], onOpen: vi.fn() }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add an item' }));
    await user.type(screen.getByRole('textbox', { name: 'Add an item' }), 'Invoice June');

    expect(
      await screen.findByText(/Suggested Owner:/, undefined, { timeout: 2000 }),
    ).toHaveTextContent('Suggested Owner: Ada Lovelace');
    expect(screen.getByText(/Suggested Reviewer:/)).toHaveTextContent(
      'Suggested Reviewer: Bob Builder',
    );
    expect(reads.count).toBe(1);
  });
});
