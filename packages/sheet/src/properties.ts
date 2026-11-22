import { type FormulaNode } from './ast.js';
import { BudgetExhausted, type EvaluationContext } from './eval-types.js';
import { topologicalOrder } from './graph.js';
import { evaluateFormula } from './evaluator.js';
import { parseFormula, parseFormulaResult } from './parser.js';
import { FORMULA_FUNCTION_ARITIES } from './functions.js';
import { type CellValue, type SheetErrorCode, sheetError } from './values.js';

/**
 * Formula properties: an expression over one item's own properties.
 *
 * The second surface of the one formula engine. A sheet body addresses cells and this addresses
 * property keys, but the lexer, the parser, the operators, the coercions and the function registry
 * underneath are the same ones - which is what goal 2.1 means by "built on the formula engine that
 * already ships rather than a second one". Only two things are this module's own: the bracketed
 * reference resolves against a property bag instead of a grid, and the dependency graph's nodes are
 * property keys instead of A1 addresses.
 *
 * **The work is split where the facts are.** Parsing an expression and ordering a set of formulas
 * depend on the *schema* and on nothing about any item, so they happen once in
 * {@link planPropertyFormulas} and the result is reused for every item the schema covers.
 * {@link evaluateFormulaPlan} does only what genuinely differs per item: walking the trees against
 * that item's values. Doing both per item measured 10.49 ms for 3,000 items with three formulas
 * each; planned once, the same work is 3.02 ms, and the schema-invariant objects the per-item
 * version allocated - about 90 per item, some 276,000 across that page - are gone with it. On a
 * container of that size the derivation runs twice per property edit, once optimistically and once
 * on the server's answer, so this is a per-write path. Goal 2.4's rule is that evaluation must not
 * turn a list render into a dependency walk, and rebuilding the dependency graph three thousand
 * times is that walk.
 *
 * **Values are never stored.** A formula property is computed wherever it is read, from the values
 * the item carries at that moment, so it cannot go stale and there is nothing to recompute on a
 * write. That is also why nothing here touches I/O, a clock or randomness: the same bag produces
 * the same values everywhere, the property the engine already holds for sheets.
 *
 * **The value domain is the sheet's.** A formula yields a number, text, a boolean, empty, or one of
 * the sheet error values - the same closed set a cell holds, formatted by the same
 * `formatCellValue`. A property type of its own for computed results would be a second value domain
 * to coerce, compare and render.
 */

/** One formula property, as the schema declares it. */
export interface PropertyFormula {
  /** The property key the computed value is published under. */
  readonly key: string;
  /**
   * The expression, without a leading `=`. Stored bare because a formula property is *only* ever a
   * formula - unlike a cell, which is a literal until the `=` says otherwise - so the sigil would
   * carry no information and a person forgetting it would author a property that silently reads as
   * the text of its own expression.
   */
  readonly expression: string;
}

export interface PropertyFormulaLimits {
  /**
   * Evaluation budget for one item, spent walking the parsed trees.
   *
   * Small on purpose: a formula property is evaluated once per item per render, and a list of three
   * thousand children multiplies whatever this is by three thousand. The sheet's 500,000 is a
   * budget for one document; this is a budget for one row of a table.
   *
   * **It buys evaluation and nothing else.** Parsing used to be charged here too, which made this
   * mostly a character budget shared across the schema: once the *sum* of a schema's expression
   * lengths passed the ceiling, every formula in it read `#LIMIT!` - twenty columns averaging 270
   * characters was enough - and Core stored such a schema happily, because it checks each
   * expression's length and never their total. Parsing now happens once per schema, under its own
   * backstop, so one long formula can no longer spend another's budget.
   */
  readonly maxOps: number;

  /** Length of one expression. */
  readonly maxLength: number;
}

export const PROPERTY_FORMULA_LIMITS: PropertyFormulaLimits = {
  maxOps: 5_000,
  maxLength: 1_024,
};

/**
 * What each error means on this surface, in the words that go next to it.
 *
 * **Its own map rather than `SHEET_ERROR_HELP`, because three of those sentences are false here.**
 * A grid's `#NAME?` is an unknown function; a property formula's is overwhelmingly a property name
 * that does not exist, which is the whole point of resolving fields at all. A grid's `#REF!` is a
 * cell outside the sheet; here it is any cell reference whatsoever, because there is no sheet. And
 * `#LIMIT!` cannot be about "this sheet" on a surface that has none. Reusing one map would ship
 * three confident sentences that send somebody looking in the wrong place, which is worse than the
 * bare code - and the bare code alone tells nobody what to do, which is why `SHEET_ERROR_HELP`
 * exists in the first place.
 */
export const PROPERTY_FORMULA_HELP: Readonly<Record<SheetErrorCode, string>> = {
  '#DIV/0!': 'This formula divides by zero.',
  '#REF!':
    'A formula reads other properties by name in square brackets, as [estimate], and cannot read spreadsheet cells.',
  '#CYCLE!': 'This formula refers to itself, directly or through another formula.',
  '#VALUE!': 'This formula uses a value of the wrong kind, such as text where a number is needed.',
  '#NAME?': 'This formula uses a property name that nothing here declares, or an unknown function.',
  '#LIMIT!': 'This formula is too long or too involved to finish evaluating.',
  '#PARSE!': "This formula isn't written in a way the parser understands.",
};

/**
 * A schema's formulas, parsed and ordered: everything about them that no item can change.
 *
 * Build one with {@link planPropertyFormulas} and hand it to {@link evaluateFormulaPlan}. The
 * fields are readable because a plan is inert data and hiding it behind a class would buy nothing,
 * but nothing outside this module should be assembling one.
 */
export interface PropertyFormulaPlan {
  /** Every formula key the schema declared, so an evaluation can answer for all of them. */
  readonly keys: readonly string[];

  /** The parsed trees, keyed by property key. Excludes anything already settled in {@link fixed}. */
  readonly nodes: ReadonlyMap<string, FormulaNode>;

  /**
   * Keys whose value is decided by the schema alone - an expression that will not parse, one too
   * long to evaluate, one on or downstream of a cycle. Settled once rather than rediscovered per
   * item, because none of them can come out differently for a different item.
   */
  readonly fixed: ReadonlyMap<string, CellValue>;

  /** Evaluation order: every precedent before its dependent. */
  readonly order: readonly string[];

  readonly limits: PropertyFormulaLimits;
}

/** A plan over no formulas at all, which is what most schemas have. */
const EMPTY_PLAN: PropertyFormulaPlan = {
  keys: [],
  nodes: new Map(),
  fixed: new Map(),
  order: [],
  limits: PROPERTY_FORMULA_LIMITS,
};

export interface PropertyFormulaEvaluation {
  /** One value per formula property, keyed by property key. */
  readonly values: ReadonlyMap<string, CellValue>;
  readonly opsUsed: number;
  readonly exceeded: boolean;
}

/**
 * Reads one item's non-computed values, already in the sheet's value domain.
 *
 * Returning `undefined` means "nothing declares this property", which is `#NAME?` - told apart from
 * `null`, which means the property exists and is empty and coerces to zero or the empty string like
 * an empty cell. A formula quietly treating a misspelled key as zero is the failure this
 * distinction exists to prevent. Which of the two an absent bag entry is, is the *caller's* to
 * know: a declared property nobody has filled in is empty, not unknown.
 */
export type PropertyReader = (key: string) => CellValue | undefined;

/**
 * The property keys an expression reads, or null when it does not parse.
 *
 * Separate from evaluation because the two questions are asked in different places: the schema
 * editor asks what a draft refers to before anything is stored - so it can say "this refers to
 * [foo], which nothing here declares" while somebody is still typing - and Core asks the same
 * question of a submitted schema to refuse a cycle. Neither of them has an item to evaluate
 * against.
 */
export function formulaFieldNames(expression: string): readonly string[] | null {
  if (expression.length > PROPERTY_FORMULA_LIMITS.maxLength) return null;
  const parsed = parseFormula(expression);
  if (parsed === null) {
    return null;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  collectFields(parsed, (name) => {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });

  return names;
}

/** Static authoring feedback from the same parser and function contracts used to evaluate. */
export function propertyFormulaProblem(
  expression: string,
  available: ReadonlySet<string>,
): string | null {
  if (expression.length > PROPERTY_FORMULA_LIMITS.maxLength) {
    return `Use at most ${String(PROPERTY_FORMULA_LIMITS.maxLength)} characters. This formula will read as #LIMIT!.`;
  }
  if (expression.trim().length === 0) return null;
  if (expression.trimStart().startsWith('=')) {
    return 'Write the expression without a leading =. Only spreadsheet cells need =. This formula will read as #PARSE!.';
  }
  const parsed = parseFormulaResult(expression);
  if (!parsed.ok) {
    return `At character ${String(parsed.position + 1)}: ${parsed.message} This formula will read as #PARSE!.`;
  }
  const pending = [parsed.node];
  const unknown = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    switch (node.kind) {
      case 'field':
        if (!available.has(node.name)) unknown.add(node.name);
        break;
      case 'ref':
      case 'range':
        return PROPERTY_FORMULA_HELP['#REF!'];
      case 'call': {
        const arity = FORMULA_FUNCTION_ARITIES.get(node.name);
        if (arity === undefined)
          return `${node.name} is not a supported function. This formula can read as #NAME?.`;
        const [min, max] = arity;
        if (node.args.length < min || (max !== null && node.args.length > max)) {
          const count =
            max === null
              ? `at least ${String(min)}`
              : min === max
                ? String(min)
                : `${String(min)} to ${String(max)}`;
          return `${node.name} expects ${count} ${max === 1 ? 'argument' : 'arguments'}. This formula can read as #VALUE!.`;
        }
        pending.push(...node.args);
        break;
      }
      case 'unary':
      case 'percent':
        pending.push(node.operand);
        break;
      case 'binary':
        pending.push(node.right, node.left);
        break;
      case 'number':
      case 'string':
      case 'boolean':
        break;
    }
  }
  return unknown.size === 0
    ? null
    : `${[...unknown].map((name) => `[${name}]`).join(', ')} ${unknown.size === 1 ? 'is not a property' : 'are not properties'} anything here declares. Use the field key shown below. This formula can read as #NAME?.`;
}

/**
 * Parses and orders a schema's formulas, once.
 *
 * A formula may read another formula's value, so the set is ordered before it is evaluated and
 * anything on or downstream of a cycle answers `#CYCLE!` - the sheet's rule, for the sheet's
 * reason: a value computed from a cycle is as unanswerable as the cycle itself. Ordering here
 * rather than through `orderFormulas` because that one's graph nodes are A1 addresses and these are
 * property keys; the algorithm is Kahn's in both.
 *
 * **The planning budget is a backstop, not a gate.** It allows each formula its own full op budget,
 * which input that passed the per-expression length check can never reach - the longest legal
 * expression costs a fifth of one formula's allowance to parse. It exists so that a plan built from
 * something pathological terminates, not so that a large schema is refused. Refusing an expression
 * is Core's job, one at a time, where the person authoring it can be told which one.
 */
export function planPropertyFormulas(
  formulas: readonly PropertyFormula[],
  limits: PropertyFormulaLimits = PROPERTY_FORMULA_LIMITS,
): PropertyFormulaPlan {
  if (formulas.length === 0) {
    return limits === PROPERTY_FORMULA_LIMITS ? EMPTY_PLAN : { ...EMPTY_PLAN, limits };
  }

  const ceiling = formulas.length * limits.maxOps;
  let spent = 0;
  const charge = (count: number): void => {
    spent += count;
    if (spent > ceiling) {
      throw new BudgetExhausted();
    }
  };

  const nodes = new Map<string, FormulaNode>();
  const fixed = new Map<string, CellValue>();
  const keys: string[] = [];

  try {
    for (const formula of formulas) {
      keys.push(formula.key);

      if (formula.expression.length > limits.maxLength) {
        fixed.set(formula.key, sheetError('#LIMIT!'));
        continue;
      }

      charge(formula.expression.length);
      const parsed = parseFormula(formula.expression);
      if (parsed === null) {
        fixed.set(formula.key, sheetError('#PARSE!'));
        continue;
      }

      nodes.set(formula.key, parsed);
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) {
      throw error;
    }
  }

  const { order, cyclic } = orderByReference(nodes, charge);
  for (const key of cyclic) {
    fixed.set(key, sheetError('#CYCLE!'));
    nodes.delete(key);
  }

  // Anything the backstop cut off before it could be parsed or ordered says so rather than being
  // absent - the same posture the evaluation below takes, for the same reason.
  for (const formula of formulas) {
    if (!nodes.has(formula.key) && !fixed.has(formula.key)) {
      fixed.set(formula.key, sheetError('#LIMIT!'));
    }
  }

  return { keys, nodes, fixed, order, limits };
}

/**
 * Evaluates a planned schema's formulas against one item.
 *
 * Everything that could be settled without the item has been; what happens here is a walk of the
 * parsed trees, charged against a budget that belongs to this item alone.
 */
export function evaluateFormulaPlan(
  plan: PropertyFormulaPlan,
  read: PropertyReader,
): PropertyFormulaEvaluation {
  if (plan.keys.length === 0) {
    return EMPTY_EVALUATION;
  }

  const values = new Map<string, CellValue>(plan.fixed);
  let opsUsed = 0;
  let exceeded = false;
  const charge = (count: number): void => {
    opsUsed += count;
    if (opsUsed > plan.limits.maxOps) {
      exceeded = true;
      throw new BudgetExhausted();
    }
  };

  const context: EvaluationContext = {
    // A formula property addresses properties, never cells. A stray A1 in one refers to nothing
    // this surface has, which is what #REF! says.
    readCell: () => sheetError('#REF!'),
    readField: (name) => {
      const computed = values.get(name);
      if (computed !== undefined) {
        return computed;
      }

      const stored = read(name);
      return stored === undefined ? sheetError('#NAME?') : stored;
    },
    charge,
  };

  for (const key of plan.order) {
    const node = plan.nodes.get(key);
    if (node === undefined) {
      continue;
    }

    try {
      values.set(key, evaluateFormula(node, context));
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) {
        throw error;
      }
      break;
    }
  }

  // Whatever the budget cut off says so rather than being absent, so a caller never has to tell
  // "no value yet" from "no value ever".
  for (const key of plan.keys) {
    if (!values.has(key)) {
      values.set(key, sheetError('#LIMIT!'));
    }
  }

  return { values, opsUsed, exceeded };
}

/**
 * Plans and evaluates in one call, for a caller holding exactly one item.
 *
 * Never used over a page: it rebuilds the plan per item, which is the cost the split exists to
 * remove.
 */
export function evaluatePropertyFormulas(
  input: { readonly formulas: readonly PropertyFormula[]; readonly read: PropertyReader },
  limits: PropertyFormulaLimits = PROPERTY_FORMULA_LIMITS,
): PropertyFormulaEvaluation {
  return evaluateFormulaPlan(planPropertyFormulas(input.formulas, limits), input.read);
}

const EMPTY_EVALUATION: PropertyFormulaEvaluation = {
  values: new Map(),
  opsUsed: 0,
  exceeded: false,
};

interface ReferenceOrder {
  readonly order: readonly string[];
  readonly cyclic: ReadonlySet<string>;
}

function orderByReference(
  nodes: ReadonlyMap<string, FormulaNode>,
  charge: (count: number) => void,
): ReferenceOrder {
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of nodes.keys()) {
    dependents.set(key, []);
    indegree.set(key, 0);
  }

  try {
    for (const [key, node] of nodes) {
      const precedents = new Set<string>();
      collectFields(node, (name) => {
        charge(1);
        // Only a formula is a graph node: a stored property is a constant for the length of one
        // evaluation and can never depend on anything.
        if (nodes.has(name)) {
          precedents.add(name);
        }
      });

      for (const precedent of precedents) {
        dependents.get(precedent)?.push(key);
        indegree.set(key, (indegree.get(key) ?? 0) + 1);
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) {
      throw error;
    }
    // The partial graph left behind is never trusted: the planner stamps #LIMIT! on everything it
    // did not settle, so nothing computed from a half-built graph survives.
  }

  return topologicalOrder(dependents, indegree);
}

function collectFields(node: FormulaNode, visit: (name: string) => void): void {
  switch (node.kind) {
    case 'field':
      visit(node.name);
      return;
    case 'unary':
    case 'percent':
      collectFields(node.operand, visit);
      return;
    case 'binary':
      collectFields(node.left, visit);
      collectFields(node.right, visit);
      return;
    case 'call':
      for (const argument of node.args) {
        collectFields(argument, visit);
      }
      return;
    case 'ref':
    case 'range':
    case 'number':
    case 'string':
    case 'boolean':
      return;
  }
}
