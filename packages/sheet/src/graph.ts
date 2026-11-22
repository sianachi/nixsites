import { type FormulaNode } from './ast.js';
import { BudgetExhausted } from './eval-types.js';
import { type CellRange, type CellRef, cellKey, normalizeRange, parseCellKey } from './refs.js';

/**
 * Dependency extraction and ordering. Only formula cells are graph nodes:
 * literals are constants and empty cells never change during a pass, so an
 * edge exists from precedent P to dependent F only when P is itself a
 * formula.
 */

export interface FormulaDependencies {
  readonly cells: readonly CellRef[];
  readonly ranges: readonly CellRange[];
}

export function collectDependencies(node: FormulaNode): FormulaDependencies {
  const cells: CellRef[] = [];
  const ranges: CellRange[] = [];
  const walk = (n: FormulaNode): void => {
    switch (n.kind) {
      case 'ref':
        cells.push({ row: n.ref.row, col: n.ref.col });
        return;
      case 'range':
        ranges.push(normalizeRange(n.start, n.end));
        return;
      case 'unary':
      case 'percent':
        walk(n.operand);
        return;
      case 'binary':
        walk(n.left);
        walk(n.right);
        return;
      case 'call':
        for (const arg of n.args) {
          walk(arg);
        }
        return;
      // A field is a value the context supplies, not a cell this sheet holds,
      // so it contributes no edge to the grid's dependency graph. Property
      // formulas order themselves in `properties.ts`, where the keys are the
      // graph nodes.
      case 'field':
      case 'number':
      case 'string':
      case 'boolean':
        return;
    }
  };
  walk(node);
  return { cells, ranges };
}

export interface TopologicalOrder {
  /** Formula cell keys in an order where every precedent comes first. */
  readonly order: readonly string[];
  /** Formula cell keys on or downstream of a reference cycle. */
  readonly cyclic: ReadonlySet<string>;
}

/**
 * Kahn's algorithm over the formula cells. Anything left when the queue
 * drains sits on a cycle or behind one; both evaluate to #CYCLE!, because a
 * value computed from a cycle is as unanswerable as the cycle itself.
 *
 * **A range's edges cost budget, one op per row scanned.** Formula cells are
 * indexed by row first, so a range only walks the rows it spans rather than
 * every formula cell in the document - but even a row-by-row walk is a whole
 * column's height for one formula, and a document can hold many such
 * formulas. Charging here, through the same `charge` the evaluator uses,
 * means the same op budget that bounds evaluation also bounds getting to
 * it: a document whose *dependency graph* is too expensive to build is
 * refused exactly like one whose evaluation is, rather than stalling the
 * process first and asking the question never.
 */
export function orderFormulas(
  formulas: ReadonlyMap<string, FormulaDependencies>,
  charge: (count: number) => void,
): TopologicalOrder {
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of formulas.keys()) {
    dependents.set(key, []);
    indegree.set(key, 0);
  }

  const byRow = new Map<number, { col: number; key: string }[]>();
  for (const key of formulas.keys()) {
    const ref = parseCellKey(key);
    if (ref === null) {
      continue;
    }
    const bucket = byRow.get(ref.row);
    if (bucket === undefined) {
      byRow.set(ref.row, [{ col: ref.col, key }]);
    } else {
      bucket.push({ col: ref.col, key });
    }
  }

  // Sorted by column, so a range reads only the span of a row it covers: a narrow range over a
  // wide sheet otherwise tests every formula in each of its rows.
  for (const bucket of byRow.values()) {
    bucket.sort((left, right) => left.col - right.col);
  }

  try {
    for (const [key, deps] of formulas) {
      const precedents = new Set<string>();
      for (const cell of deps.cells) {
        charge(1);
        const precedentKey = cellKey(cell);
        if (formulas.has(precedentKey)) {
          precedents.add(precedentKey);
        }
      }
      for (const range of deps.ranges) {
        for (let row = range.startRow; row <= range.endRow; row += 1) {
          charge(1);
          const bucket = byRow.get(row);
          if (bucket === undefined) {
            continue;
          }
          let low = 0;
          let high = bucket.length;
          while (low < high) {
            const middle = (low + high) >> 1;
            if ((bucket[middle]?.col ?? 0) < range.startCol) {
              low = middle + 1;
            } else {
              high = middle;
            }
          }
          for (let at = low; at < bucket.length; at += 1) {
            const candidate = bucket[at];
            if (candidate === undefined || candidate.col > range.endCol) {
              break;
            }
            precedents.add(candidate.key);
          }
        }
      }
      for (const precedentKey of precedents) {
        const list = dependents.get(precedentKey);
        if (list !== undefined) {
          list.push(key);
        }
        indegree.set(key, (indegree.get(key) ?? 0) + 1);
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) {
      throw error;
    }
    // The graph this leaves behind is partial - some edges were never added,
    // so the topological order below may be wrong for cells that budget
    // exhaustion cut off from having their precedents recorded. That is
    // safe rather than merely tolerated: `charge` shares its running total
    // with the evaluator's own calls, so the very next charge - the
    // evaluator's first, on whichever cell the order visits first - is
    // already past the ceiling and throws before any value is computed.
    // Nothing computed from this graph is ever kept; every formula cell
    // ends up #LIMIT! through the engine's own fallback.
  }

  return topologicalOrder(dependents, indegree);
}

/**
 * Kahn's algorithm over a built graph: `indegree` holds every node (its count of unsettled
 * precedents) and `dependents` the nodes that wait on each one. Nodes left over are in a cycle.
 */
export function topologicalOrder(
  dependents: ReadonlyMap<string, readonly string[]>,
  indegree: Map<string, number>,
): { readonly order: string[]; readonly cyclic: Set<string> } {
  const queue: string[] = [];
  for (const [key, degree] of indegree) {
    if (degree === 0) {
      queue.push(key);
    }
  }
  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const key = queue[head];
    head += 1;
    if (key === undefined) {
      break;
    }
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        queue.push(dependent);
      }
    }
  }
  const cyclic = new Set<string>();
  if (order.length < indegree.size) {
    const ordered = new Set(order);
    for (const key of indegree.keys()) {
      if (!ordered.has(key)) {
        cyclic.add(key);
      }
    }
  }
  return { order, cyclic };
}
