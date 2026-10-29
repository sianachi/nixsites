import { describe, expect, it } from 'vitest';

import {
  SMART_LIST_STARTERS,
  STRUCTURED_RECIPES,
  findStructuredRecipe,
  viewForRecipe,
} from '../../../wizard/structured-recipes';

describe('the structured-view recipe registry', () => {
  it('defines every guided action in one registry', () => {
    expect(STRUCTURED_RECIPES.filter((recipe) => recipe.menu === 'structured')).toHaveLength(11);
    expect(STRUCTURED_RECIPES.filter((recipe) => recipe.menu === 'view')).toHaveLength(5);
    expect(STRUCTURED_RECIPES.map((recipe) => recipe.id)).toEqual([
      'board',
      'timeline',
      'gallery',
      'sheet',
      'form',
      'interactive-form',
      'query',
      'chart',
      'calendar',
      'list',
      'checklist',
      'matrix',
      'outline',
      'drive',
      'habit-tracker',
      'finances',
    ]);
  });

  it.each(STRUCTURED_RECIPES)('builds a complete $id starting view', (recipe) => {
    const view = viewForRecipe(recipe, recipe.properties);

    expect(view.kind).toBe(recipe.viewKind);
    expect(view.name).toBe(recipe.defaultViewName);
    // A checklist shows one chosen property beside each line, so it starts with none rather than
    // every property the recipe declares.
    expect(view.columns).toEqual(
      recipe.viewKind === 'checklist'
        ? []
        : ['title', ...recipe.properties.map((property) => property.key)],
    );
    expect(view.companionViewId).toBeNull();
    expect(view.companionPlacement).toBeNull();
  });

  it('prefills the complete first page for an interactive form', () => {
    const recipe = findStructuredRecipe('interactive-form');
    expect(recipe).not.toBeNull();
    if (recipe === null) return;

    const form = viewForRecipe(recipe, recipe.properties).interactiveForm;
    expect(form?.pages).toHaveLength(1);
    expect(form?.pages[0]?.blocks[0]).toMatchObject({
      kind: 'field',
      propertyKey: 'response',
    });
    expect(form?.confirmationTitle).toBe('Response received');
  });

  it('keeps date and assignment shortcuts inside the Smart list wizard', () => {
    expect(SMART_LIST_STARTERS.map((starter) => starter.label)).toEqual([
      'Today',
      'Next 7 days',
      'Overdue',
      'Assigned to me',
    ]);
  });

  /**
   * The starters are bound to goal 3.1's reserved task-semantic keys (ADR-0042), not workspace
   * conventions - a future rename of `due_date`, `completion` or `assignee` must fail here rather
   * than silently shipping a wizard shortcut that compiles to a filter that matches nothing.
   */
  it.each([
    ['today', [{ property: 'due_date', operator: 'on', value: 'today' }]],
    ['next-seven-days', [{ property: 'due_date', operator: 'within-next', value: '7' }]],
    [
      'overdue',
      [
        { property: 'due_date', operator: 'before', value: 'today' },
        { property: 'completion', operator: 'not-equals', value: 'true' },
      ],
    ],
    ['assigned-to-me', [{ property: 'assignee', operator: 'equals', value: 'me' }]],
  ] as const)('binds the %s starter to its reserved-key filters', (id, filters) => {
    const starter = SMART_LIST_STARTERS.find((candidate) => candidate.id === id);
    expect(starter?.filters).toEqual(filters);
  });

  it('sends the literal token me for Assigned to me, never a resolved identifier', () => {
    const starter = SMART_LIST_STARTERS.find((candidate) => candidate.id === 'assigned-to-me');
    expect(starter?.filters[0]?.value).toBe('me');
  });
});
