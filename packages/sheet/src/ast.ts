import { type A1Ref } from './refs.js';

/**
 * The formula grammar's shape after parsing. Nodes carry no evaluation state;
 * the evaluator walks them against a cell reader and an op budget.
 */

interface NumberNode {
  readonly kind: 'number';
  readonly value: number;
}

interface StringNode {
  readonly kind: 'string';
  readonly value: string;
}

interface BooleanNode {
  readonly kind: 'boolean';
  readonly value: boolean;
}

interface RefNode {
  readonly kind: 'ref';
  readonly ref: A1Ref;
}

/**
 * A named value supplied by the evaluation context rather than read out of the
 * grid: `[estimate]` in a formula property, resolved against the item's own
 * properties. A sheet body never produces one - the lexer only emits a field
 * token for bracketed text, which no stored sheet formula can contain - so the
 * node is inert on that surface and `readField` may be absent there.
 */
interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
}

interface RangeNode {
  readonly kind: 'range';
  readonly start: A1Ref;
  readonly end: A1Ref;
}

type UnaryOperator = '-' | '+';

interface UnaryNode {
  readonly kind: 'unary';
  readonly op: UnaryOperator;
  readonly operand: FormulaNode;
}

interface PercentNode {
  readonly kind: 'percent';
  readonly operand: FormulaNode;
}

export type BinaryOperator =
  '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

interface BinaryNode {
  readonly kind: 'binary';
  readonly op: BinaryOperator;
  readonly left: FormulaNode;
  readonly right: FormulaNode;
}

interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly FormulaNode[];
}

export type FormulaNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | RefNode
  | FieldNode
  | RangeNode
  | UnaryNode
  | PercentNode
  | BinaryNode
  | CallNode;
