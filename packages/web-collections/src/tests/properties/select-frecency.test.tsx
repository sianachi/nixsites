import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PropertyInput } from '../../properties/property-input';
import { frecencyScores, recordPick } from '@nix/web-foundation/lib/frecency';
import { useChoiceOrderPreference } from '@nix/web-foundation/lib/suggestion-preferences';
import type { PropertyDefinition } from '../../core/container-model';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

/**
 * Select options keep their declared order; what this person usually picks, per workspace and
 * property, is offered again in a leading "Recent" group - and nothing is remembered where there
 * is no workspace or the preference is off.
 */

const WORKSPACE = { current: 'dddddddd-4444-4444-8444-dddddddddddd' as string | null };

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useOptionalWorkspace: () =>
    WORKSPACE.current === null ? null : { workspaceId: WORKSPACE.current },
}));

const STATUS: PropertyDefinition = {
  key: 'status',
  label: 'Status',
  type: 'select',
  options: ['Backlog', 'Doing', 'Done'],
  required: false,
};

const TAGS: PropertyDefinition = {
  key: 'tags',
  label: 'Tags',
  type: 'multi_select',
  options: ['home', 'money', 'work'],
  required: false,
};

function groupNames(): string[] {
  return within(screen.getByRole('combobox', { name: 'Status' }))
    .queryAllByRole('group')
    .map((group) => group.getAttribute('label') ?? '');
}

function recentNames(): string[] {
  const recent = within(screen.getByRole('combobox', { name: 'Status' })).queryByRole('group', {
    name: 'Recent',
  });
  return recent === null
    ? []
    : within(recent)
        .getAllByRole('option')
        .map((option) => option.textContent);
}

function optionNames(): string[] {
  return within(screen.getByRole('combobox', { name: 'Status' }))
    .getAllByRole('option')
    .map((option) => option.textContent);
}

beforeEach(() => {
  WORKSPACE.current = 'dddddddd-4444-4444-8444-dddddddddddd';
  vi.stubGlobal('localStorage', memoryStorage());
  useChoiceOrderPreference.setState({ setting: 'on', saved: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('select options by habit', () => {
  it('keeps the declared order, with no Recent group, when nothing has been picked', () => {
    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={STATUS} onCommit={vi.fn()} />,
    );
    expect(optionNames()).toEqual(['Unset', 'Backlog', 'Doing', 'Done']);
    expect(groupNames()).toEqual([]);
  });

  it('offers the usual picks again in a leading Recent group without reordering the rest', () => {
    const namespace = `select:${WORKSPACE.current ?? ''}:status`;
    recordPick(namespace, 'Done');
    recordPick(namespace, 'Done');
    recordPick(namespace, 'Doing');

    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={STATUS} onCommit={vi.fn()} />,
    );
    expect(groupNames()).toEqual(['Recent', 'All options']);
    expect(recentNames()).toEqual(['Done', 'Doing']);
    expect(optionNames()).toEqual(['Unset', 'Done', 'Doing', 'Backlog', 'Doing', 'Done']);
  });

  it('offers at most three recent picks', () => {
    const many: PropertyDefinition = { ...STATUS, options: ['a', 'b', 'c', 'd', 'e'] };
    const namespace = `select:${WORKSPACE.current ?? ''}:status`;
    for (const value of ['e', 'd', 'c', 'b']) {
      recordPick(namespace, value);
    }

    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={many} onCommit={vi.fn()} />,
    );
    expect(recentNames()).toHaveLength(3);
  });

  it('shows no Recent group and remembers nothing when ordering by picks is off', () => {
    useChoiceOrderPreference.setState({ setting: 'off', saved: true });
    const namespace = `select:${WORKSPACE.current ?? ''}:status`;
    recordPick(namespace, 'Done');

    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={STATUS} onCommit={vi.fn()} />,
    );
    expect(groupNames()).toEqual([]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'Doing' },
    });
    expect(frecencyScores(namespace).has('Doing')).toBe(false);
  });

  it('remembers a choice under the workspace and property, and not a clear', () => {
    const onCommit = vi.fn();
    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={STATUS} onCommit={onCommit} />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'Doing' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: '' } });

    expect(onCommit).toHaveBeenNthCalledWith(1, 'Doing');
    expect(onCommit).toHaveBeenNthCalledWith(2, null);
    const scores = frecencyScores(`select:${WORKSPACE.current ?? ''}:status`);
    expect([...scores.keys()]).toEqual(['Doing']);
  });

  it('leaves multi-select options in their declared order', () => {
    recordPick(`select:${WORKSPACE.current ?? ''}:tags`, 'work');
    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={TAGS} onCommit={vi.fn()} />,
    );

    const boxes = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent);
    expect(boxes).toEqual(['home', 'money', 'work']);
  });

  it('remembers nothing outside a workspace', () => {
    WORKSPACE.current = null;
    render(
      <PropertyInput item={{ title: 'A', properties: {} }} property={STATUS} onCommit={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'Doing' },
    });
    expect(localStorage.length).toBe(0);
  });
});
