import { fireEvent, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { renderAt } from '@nix/web-editor/testing/render-with-router';
import {
  filterGroup,
  type PropertyDefinition,
  type ViewFilterRule,
} from '../../../collections/core/container-model';
import { FilterRulesEditor } from '../../../views/core/filter-rules-editor';

/**
 * The filter-rules editor: rows of property, condition and value, with the two honesty properties
 * that matter - a property is typed rather than picked (the query spans containers), and a token
 * from a newer build survives the editor untouched.
 */

const SCHEMA: readonly PropertyDefinition[] = [
  { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  { key: 'status', label: 'Status', type: 'select', options: ['Doing'], required: false },
];

function editorWith(
  initial: readonly ViewFilterRule[],
  scope: 'query' | 'container' = 'query',
): {
  current: () => readonly ViewFilterRule[];
} {
  let latest: readonly ViewFilterRule[] = initial;

  function Harness(): ReactNode {
    const [rules, setRules] = useState<readonly ViewFilterRule[]>(initial);
    latest = rules;
    return (
      <FilterRulesEditor
        rules={rules}
        schema={SCHEMA}
        scope={scope}
        onChange={(next) => {
          setRules(next);
        }}
      />
    );
  }

  renderAt(<Harness />);
  return { current: () => latest };
}

function renderEditor(
  rules: readonly ViewFilterRule[],
  scope: 'query' | 'container',
): { unmount: () => void } {
  return renderAt(
    <FilterRulesEditor rules={rules} schema={SCHEMA} scope={scope} onChange={() => undefined} />,
  );
}

describe('the filter rules editor', () => {
  it('adds a rule ready to be filled', () => {
    const rules = editorWith([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add a filter' }));

    expect(rules.current()).toEqual([{ property: '', operator: 'equals', value: '' }]);
    expect(screen.getByLabelText('Property')).toBeInTheDocument();
  });

  it('edits a rule field by field', () => {
    const rules = editorWith([{ property: 'due', operator: 'before', value: 'today' }]);

    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '2026-09-01' } });

    expect(rules.current()).toEqual([{ property: 'due', operator: 'before', value: '2026-09-01' }]);
  });

  it('removes the one rule its button names', () => {
    const rules = editorWith([
      { property: 'due', operator: 'before', value: 'today' },
      { property: 'done', operator: 'not-equals', value: 'true' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Remove the filter on due' }));

    expect(rules.current()).toEqual([{ property: 'done', operator: 'not-equals', value: 'true' }]);
  });

  it('hints the value grammar the chosen operator reads', () => {
    editorWith([{ property: 'due', operator: 'within-next', value: '7' }]);

    expect(screen.getByText('A number of days, 1 to 365')).toBeInTheDocument();
  });

  it('preserves an operator token from a newer build rather than rewriting it', () => {
    const rules = editorWith([{ property: 'due', operator: 'sometime-around', value: 'x' }]);

    // The stray token is offered as the current choice, and leaving the row alone changes
    // nothing: only the server executes, and this build must not silently rewrite a saved rule.
    expect(screen.getByLabelText('Condition')).toHaveValue('sometime-around');
    expect(rules.current()).toEqual([{ property: 'due', operator: 'sometime-around', value: 'x' }]);
  });

  it('says the rules run across containers, which is why the property is typed', () => {
    editorWith([]);

    expect(screen.getByText(/across every container you can read/)).toBeInTheDocument();
  });

  it('offers both scopes every operator Core compiles', () => {
    for (const scope of ['query', 'container'] as const) {
      const { unmount } = renderEditor(
        [{ property: 'status', operator: 'equals', value: 'Doing' }],
        scope,
      );

      const offered = screen
        .getAllByRole('option')
        .filter((option) => option.closest('select') !== null)
        .map((option) => option.textContent);
      expect(offered).toEqual([
        'is',
        'is not',
        'is on',
        'is before',
        'is on or after',
        'is within the next (days)',
        'is within the last (days)',
        'contains',
        'does not contain',
        'is more than',
        'is less than',
        'is empty',
        'is not empty',
      ]);
      unmount();
    }
  });

  it('suggests the structural fields on a query only', () => {
    const { unmount } = renderEditor([], 'query');
    const suggested = (): readonly string[] =>
      Array.from(document.querySelectorAll('datalist option')).map(
        (option) => (option as HTMLOptionElement).value,
      );

    expect(suggested()).toEqual(
      expect.arrayContaining(['$type', '$inside', '$created', '$modified', '$done']),
    );
    unmount();

    renderEditor([], 'container');
    expect(suggested()).not.toContain('$type');
  });

  it('suggests computed fields for loaded container filters and excludes them from smart lists', () => {
    const schema = [
      ...SCHEMA,
      { key: 'score', label: 'Score', type: 'formula', options: [], required: false },
      { key: 'total', label: 'Total', type: 'rollup', options: [], required: false },
    ] satisfies readonly PropertyDefinition[];
    const query = renderAt(
      <FilterRulesEditor rules={[]} schema={schema} scope="query" onChange={() => undefined} />,
    );
    const suggested = () =>
      Array.from(document.querySelectorAll('datalist option'), (option) =>
        option.getAttribute('value'),
      );
    expect(suggested()).not.toContain('score');
    expect(suggested()).not.toContain('total');
    expect(screen.getByText(/Smart lists compare stored values/)).toBeVisible();
    query.unmount();
    renderAt(
      <FilterRulesEditor rules={[]} schema={schema} scope="container" onChange={() => undefined} />,
    );
    expect(suggested()).toContain('score');
    expect(suggested()).toContain('total');
  });

  it('warns about computed local keys in query groups while preserving cross-container free text', () => {
    renderAt(
      <FilterRulesEditor
        rules={[filterGroup([{ property: 'score', operator: 'greater-than', value: '5' }])]}
        schema={[{ key: 'score', label: 'Score', type: 'formula', options: [], required: false }]}
        scope="query"
        onChange={() => undefined}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Filters on Score compare stored values only.',
    );
    expect(screen.getByRole('combobox', { name: 'Property' })).toHaveValue('score');
    expect(screen.getByRole('combobox', { name: 'Condition' })).toHaveValue('greater-than');
    expect(screen.getByRole('textbox', { name: 'Value' })).toHaveValue('5');
  });

  it('hints the day tokens a day operator reads', () => {
    editorWith([{ property: 'due', operator: 'on', value: 'start-of-week' }]);

    expect(screen.getByText(/'start-of-week', 'start-of-month'/)).toBeInTheDocument();
  });

  it('adds an any-of group and edits, extends and empties it', () => {
    const rules = editorWith([]);

    fireEvent.click(screen.getByRole('button', { name: 'Add an any-of group' }));
    expect(rules.current()).toEqual([
      {
        property: null,
        operator: null,
        value: null,
        any: [{ property: '', operator: 'equals', value: '' }],
      },
    ]);
    expect(screen.getByRole('group', { name: 'Any of' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Property'), { target: { value: 'status' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a filter to this group' }));
    expect(rules.current()).toEqual([
      {
        property: null,
        operator: null,
        value: null,
        any: [
          { property: 'status', operator: 'equals', value: '' },
          { property: '', operator: 'equals', value: '' },
        ],
      },
    ]);

    // Removing a group's last filter removes the group: an empty one is refused on save.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the filter on this property' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the filter on status' }));
    expect(rules.current()).toEqual([]);
  });

  it('offers no group where groups cannot be stored', () => {
    renderAt(
      <FilterRulesEditor
        rules={[]}
        schema={SCHEMA}
        allowGroups={false}
        onChange={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add an any-of group' })).not.toBeInTheDocument();
  });

  it('stops adding at eight filters, counting those inside groups', () => {
    const seven = Array.from({ length: 6 }, (_unused, index) => ({
      property: `k${String(index)}`,
      operator: 'is-empty',
      value: '',
    }));
    editorWith([
      ...seven,
      {
        property: null,
        operator: null,
        value: null,
        any: [
          { property: 'a', operator: 'is-empty', value: '' },
          { property: 'b', operator: 'is-empty', value: '' },
        ],
      },
    ]);

    expect(screen.getByRole('button', { name: 'Add a filter' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add an any-of group' })).toBeDisabled();
    expect(screen.getByText(/at most 8 filters/)).toBeInTheDocument();
  });

  it('hides the value for an operator that takes none, and clears a value left behind', () => {
    const rules = editorWith(
      [{ property: 'status', operator: 'contains', value: 'Do' }],
      'container',
    );

    expect(screen.getByLabelText('Value')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'is-empty' } });

    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument();
    expect(rules.current()).toEqual([{ property: 'status', operator: 'is-empty', value: '' }]);
  });

  it('clears the value when the new operator reads a different kind of value', () => {
    // A day left under "is more than", or a number under "is on", is refused on save; the value
    // is dropped rather than carried into a grammar it does not fit.
    const rules = editorWith([{ property: 'due', operator: 'on', value: 'today' }], 'container');

    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'greater-than' } });
    expect(rules.current()).toEqual([{ property: 'due', operator: 'greater-than', value: '' }]);

    fireEvent.change(screen.getByLabelText('Value'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'contains' } });
    expect(rules.current()).toEqual([{ property: 'due', operator: 'contains', value: '' }]);
  });

  it('keeps the value when the new operator reads the same kind of value', () => {
    const rules = editorWith([{ property: 'due', operator: 'on', value: 'today' }], 'container');

    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'before' } });
    expect(rules.current()).toEqual([{ property: 'due', operator: 'before', value: 'today' }]);

    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: 'within-next' } });
    expect(rules.current()).toEqual([{ property: 'due', operator: 'within-next', value: '' }]);
  });
});
