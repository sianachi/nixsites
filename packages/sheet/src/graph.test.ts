import { describe, expect, it } from 'vitest';

import { BudgetExhausted } from './eval-types.js';
import { collectDependencies, orderFormulas } from './graph.js';
import { parseFormula } from './parser.js';

function dependenciesOf(formula: string) {
  const node = parseFormula(formula);
  if (node === null) {
    throw new Error(`test formula does not parse: ${formula}`);
  }
  return collectDependencies(node);
}

describe('dependency extraction', () => {
  it('collects direct references through every operator and call', () => {
    const deps = dependenciesOf('IF(A1>0, B2*C3, SUM(D4)) & -E5%');
    expect(deps.cells.map((c) => `${String(c.row)}:${String(c.col)}`).sort()).toEqual(
      ['0:0', '1:1', '2:2', '3:3', '4:4'].sort(),
    );
  });

  it('collects ranges normalized regardless of corner order', () => {
    const deps = dependenciesOf('SUM(B3:A1)');
    expect(deps.ranges).toEqual([{ startRow: 0, endRow: 2, startCol: 0, endCol: 1 }]);
  });
});

describe('ordering', () => {
  function order(entries: Record<string, string>) {
    const formulas = new Map(
      Object.entries(entries).map(([key, text]) => {
        const node = parseFormula(text);
        if (node === null) {
          throw new Error(`test formula does not parse: ${text}`);
        }
        return [key, collectDependencies(node)] as const;
      }),
    );
    return orderFormulas(formulas, () => undefined);
  }

  it('places precedents before dependents in a chain', () => {
    const { order: sorted, cyclic } = order({ C1: 'B1+1', B1: 'A9+1' });
    expect(cyclic.size).toBe(0);
    expect(sorted.indexOf('B1')).toBeLessThan(sorted.indexOf('C1'));
  });

  it('takes only the formulas inside a narrow range of a wide row as precedents', () => {
    // A1 sits in the range's row but outside its columns, and depends on the range's reader: were
    // it taken as a precedent the two would form a cycle.
    const { order: sorted, cyclic } = order({
      H1: '1',
      A1: 'Z1+1',
      E1: '2',
      C1: '3',
      D1: '4',
      Z1: 'SUM(C1:E1)',
    });
    expect(cyclic.size).toBe(0);
    for (const precedent of ['C1', 'D1', 'E1'])
      expect(sorted.indexOf(precedent)).toBeLessThan(sorted.indexOf('Z1'));
    expect(sorted.indexOf('Z1')).toBeLessThan(sorted.indexOf('A1'));
    expect(sorted).toEqual(['H1', 'E1', 'C1', 'D1', 'Z1', 'A1']);
  });

  it('handles a diamond without duplicating work', () => {
    const { order: sorted, cyclic } = order({
      D1: 'B1+C1',
      B1: 'A1*2',
      C1: 'A1*3',
      A1: '1+1',
    });
    expect(cyclic.size).toBe(0);
    expect(sorted.indexOf('A1')).toBeLessThan(sorted.indexOf('B1'));
    expect(sorted.indexOf('A1')).toBeLessThan(sorted.indexOf('C1'));
    expect(sorted.indexOf('B1')).toBeLessThan(sorted.indexOf('D1'));
    expect(sorted.indexOf('C1')).toBeLessThan(sorted.indexOf('D1'));
    expect(sorted).toHaveLength(4);
  });

  it('finds a self-cycle created by a range that covers its own cell', () => {
    const { cyclic } = order({ A1: 'SUM(A1:A3)' });
    expect(cyclic.has('A1')).toBe(true);
  });

  it('separates the cyclic cells from an untouched healthy subgraph', () => {
    const { order: sorted, cyclic } = order({
      A1: 'B1+1',
      B1: 'A1+1',
      X1: 'Y1+1',
      Y1: '1',
    });
    expect(cyclic).toEqual(new Set(['A1', 'B1']));
    expect(sorted).toContain('X1');
    expect(sorted).toContain('Y1');
  });

  it('sweeps cells downstream of a cycle into the cyclic set', () => {
    const { cyclic } = order({ A1: 'B1', B1: 'A1', C1: 'B1+1' });
    expect(cyclic.has('C1')).toBe(true);
  });

  it('spends the charge callback while resolving a range, bounded rather than free', () => {
    const node = parseFormula('SUM(A1:A100)');
    if (node === null) {
      throw new Error('test formula does not parse');
    }
    const formulas = new Map([['B1', collectDependencies(node)]]);
    let spent = 0;
    orderFormulas(formulas, (count) => {
      spent += count;
    });
    // One op per row the range spans (100), not zero - a whole-column range
    // must cost something before evaluation ever starts, or nothing bounds
    // the time this phase can take.
    expect(spent).toBeGreaterThanOrEqual(100);
  });

  it('stops resolving edges once the shared budget is spent, rather than finishing for free', () => {
    const node = parseFormula('SUM(A1:A10000)');
    if (node === null) {
      throw new Error('test formula does not parse');
    }
    const formulas = new Map([['B1', collectDependencies(node)]]);
    let calls = 0;
    orderFormulas(formulas, () => {
      calls += 1;
      if (calls > 50) {
        throw new BudgetExhausted();
      }
    });
    // The row-scan loop is interrupted well short of the range's 10,000 rows -
    // proof the caller's ceiling actually governs this phase, not just the
    // evaluator's.
    expect(calls).toBeLessThan(10_000);
  });
});
