import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORMULA_FUNCTION_NAMES, evaluatePropertyFormulas } from '@nix/sheet';
import { describe, expect, it } from 'vitest';

import { buildCatalog, renderCatalog } from './build.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');

function readPatterns(): string {
  return readFileSync(resolve(packageRoot, 'catalog/patterns.txt'), 'utf8');
}

describe('the capability catalog', () => {
  it('renders the catalog text at most 12000 chars', () => {
    expect(renderCatalog(buildCatalog(), readPatterns()).length).toBeLessThanOrEqual(13000);
  });

  it('documents the exact blueprint field and kind-specific view syntax', () => {
    const text = renderCatalog(buildCatalog(), readPatterns());
    expect(text).toContain('Do not use name for a field');
    expect(text).toContain('do not use properties or entries for blueprint node values');
    expect(text).toContain('under values, keyed by field key');
    expect(text).toContain('On a list, groupBy draws sections');
    expect(text).toContain('- board: groupBy');
  });

  it('discloses call limits, fixed task keys, and actual Gallery, Query and Habit settings', () => {
    const text = renderCatalog(buildCatalog(), readPatterns());
    expect(text).toContain('create_structured 6 views, add_view 4; 12 total per item');
    expect(text).toContain(
      'Task field keys equal their type: due_date, start_date, completion, priority, estimate, reminder',
    );
    expect(text).toContain('columns are not configurable');
    expect(text).toContain('not column mappings');
    expect(text).toContain('columns (field keys)');
    expect(text).toContain(
      'Columns may include title; it is an item-title marker, never a form field',
    );
    expect(text).toContain('Configure child node.habit with frequency, weekdays, target and unit');
  });

  it('offers the read-only review and requested refinement workflow', () => {
    const text = renderCatalog(buildCatalog(), readPatterns());
    expect(text).toContain('Read configuration with nix_read_structure');
    expect(text).toContain('bounded results with nix_read_view');
    expect(text).toContain('Reviews only read');
    expect(text).toContain('requested refinements use nix_update_view, then read back');
  });

  it('names every property type in PROPERTY_TYPES except assignee', () => {
    const catalog = buildCatalog();
    const names = catalog.propertyTypes.map((type) => type.type);
    expect(names).not.toContain('assignee');
    // The full type list, minus assignee, as PROPERTY_TYPES declares it (property-types.ts).
    expect(names).toEqual([
      'text',
      'long_text',
      'number',
      'select',
      'multi_select',
      'date',
      'timestamp',
      'datetime',
      'checkbox',
      'url',
      'image',
      'due_date',
      'start_date',
      'completion',
      'priority',
      'estimate',
      'formula',
      'rollup',
      'reminder',
    ]);
  });

  it('names every structure operation in the rendered text, not hand-typed', () => {
    const catalog = buildCatalog();
    const text = renderCatalog(catalog, readPatterns());

    // The Go worker's TestCatalogNamesEveryStructureOperation cross-checks this same set against
    // workspaceTools()'s enum, so a structure operation added to one side and forgotten on the
    // other fails a build.
    expect(catalog.structureOperations.length).toBeGreaterThan(0);
    for (const operation of catalog.structureOperations) {
      expect(text, `catalog should name structure operation '${operation}'`).toContain(operation);
    }
  });

  it('lists IF among the formula functions', () => {
    const catalog = buildCatalog();
    expect(catalog.formulaFunctions).toContain('IF');
    // The catalog's formula function names are exactly @nix/sheet's own list - not a hand-copy
    // that could grow, shrink or duplicate independently of what a formula can actually call.
    expect(catalog.formulaFunctions).toEqual(FORMULA_FUNCTION_NAMES);
    expect(new Set(catalog.formulaFunctions).size).toBe(catalog.formulaFunctions.length);
  });

  it('gives formula examples whose actual results match the guidance', () => {
    const text = renderCatalog(buildCatalog(), readPatterns());
    const values = new Map<string, number | boolean>([
      ['price', 12.5],
      ['quantity', 3],
      ['completion', true],
    ]);
    for (const [expression, expected] of [
      ['[price] * [quantity]', 37.5],
      ['IF([completion], "Done", "Open")', 'Done'],
      ['IFERROR(ROUND([price] * [quantity], 2), 0)', 37.5],
    ] as const) {
      expect(text).toContain(expression);
      const result = evaluatePropertyFormulas({
        formulas: [{ key: 'result', expression }],
        read: (key) => values.get(key),
      });
      expect(result.values.get('result')).toBe(expected);
    }
  });

  it('never offers the assignee property type or the drive and finances recipes', () => {
    const catalog = buildCatalog();
    const propertyTypes = catalog.propertyTypes.map((type) => type.type);
    const recipeIds = catalog.recipes.map((recipe) => recipe.id);
    const recipeViewKinds = catalog.recipes.map((recipe) => recipe.viewKind);

    expect(propertyTypes).not.toContain('assignee');
    expect(recipeIds).not.toContain('drive');
    expect(recipeIds).not.toContain('finances');
    expect(recipeViewKinds).not.toContain('drive');
    expect(recipeViewKinds).not.toContain('finance');
  });

  it('names only known field types, view kinds and operators in patterns.txt', () => {
    const catalog = buildCatalog();
    const knownFieldTypes = new Set(catalog.propertyTypes.map((type) => type.type));
    const knownViewKinds = new Set(catalog.viewKinds.map((kind) => kind.kind));
    const knownOperators = new Set(catalog.queryOperators.map((operator) => operator.op));

    const patterns = readPatterns();
    const backticked = [...patterns.matchAll(/`([^`]+)`/g)].map((match) => {
      const token = match[1];
      if (token === undefined) {
        throw new Error('a backtick regex match unexpectedly captured nothing');
      }
      return token;
    });
    expect(backticked.length).toBeGreaterThan(0);

    for (const token of backticked) {
      const known =
        knownFieldTypes.has(token) || knownViewKinds.has(token) || knownOperators.has(token);
      expect(known, `'${token}' is not a known field type, view kind or operator`).toBe(true);
    }
  });

  it('lists the property types each view requirement accepts, for the C# parity test to check', () => {
    const catalog = buildCatalog();
    const accepts = new Map(
      catalog.viewKinds.flatMap((kind) =>
        kind.requires === null ? [] : [[kind.kind, kind.requires.accepts]],
      ),
    );
    // Board grouping is single select until the web board learns the other types (ADR-0054).
    expect(accepts.get('board')).toEqual(['select']);
    // A chart buckets by a select, or puts itself on a time axis along any date-shaped type.
    expect(accepts.get('chart')).toEqual(['select', ...(accepts.get('calendar') ?? [])]);
    // Assignee is listed even though the pet may not declare one: the list is checked against
    // every PropertyType the backend defines.
    expect(accepts.get('calendar')).toEqual([
      'date',
      'timestamp',
      'datetime',
      'due_date',
      'start_date',
    ]);
    expect(accepts.get('timeline')).toEqual(accepts.get('calendar'));
  });

  it('matches a fresh build to the committed generated catalog.json', () => {
    const committed = JSON.parse(
      readFileSync(resolve(packageRoot, 'src/generated/catalog.json'), 'utf8'),
    ) as unknown;
    const fresh = JSON.parse(JSON.stringify(buildCatalog())) as unknown;
    expect(committed, 'run: pnpm --filter @nix/structure-spec catalog').toEqual(fresh);
  });
});
