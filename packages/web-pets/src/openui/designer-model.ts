/**
 * The designer's model: every visual edit is a pure text-to-text transform over an openui-lang
 * program, so the program text stays the single source of truth and Code and Design never
 * disagree.
 *
 * How untouched statements stay byte-identical: the source is cut into segments at depth-0
 * newlines (string-, bracket- and comment-aware) and each segment keeps its exact text and line
 * ending. An edit replaces, inserts or removes whole segments, and only the segments of the
 * statements it names are ever re-printed (from tokens); `join` of untouched segments is the
 * original text. A re-printed statement keeps every token but not its spacing or its comments.
 *
 * shortcut: a component referenced from two places is edited, moved and deleted through its first
 * reference; add per-reference ids if programs start sharing components.
 * shortcut: the lexer gives no source positions, so spacing inside an edited statement is
 * normalised; a position-aware rewrite would be needed to keep it.
 */
import { isReactiveSchema, parseExpression, tokenize } from '@openuidev/lang-core';

import { CONTRACTS, type ContractName } from './contracts';

// lang-core types a token's kind as a `const enum`, which cannot be named here (isolatedModules)
// and does not compare with numbers; this is the same shape with the kind as a number.
interface Token {
  t: number;
  v?: string | number;
}

// The lexer's token kinds. lang-core declares them as a `const enum`, which cannot be imported
// under isolatedModules, so the numbers are repeated here (a test round-trips every kind).
const T = {
  Newline: 0,
  LParen: 1,
  RParen: 2,
  LBrack: 3,
  RBrack: 4,
  LBrace: 5,
  RBrace: 6,
  Comma: 7,
  Colon: 8,
  Equals: 9,
  True: 10,
  False: 11,
  Null: 12,
  EOF: 13,
  Str: 14,
  Num: 15,
  Ident: 16,
  Type: 17,
  StateVar: 18,
  Dot: 19,
  Plus: 20,
  Minus: 21,
  Not: 33,
  Question: 34,
  BuiltinCall: 35,
} as const;

const oneOf = (t: number, ...ts: number[]): boolean => ts.includes(t);
const tok = (t: number, v?: string | number): Token => (v === undefined ? { t } : { t, v });
const OPEN = new Set<number>([T.LParen, T.LBrack, T.LBrace]);
const CLOSE = new Set<number>([T.RParen, T.RBrack, T.RBrace]);
// Binary operators sit between Plus and Slash..LessEq, And, Or in the lexer's numbering.
const BINARY = new Set<number>([20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
const VALUE_END = new Set<number>([
  T.Ident,
  T.Num,
  T.Str,
  T.StateVar,
  T.True,
  T.False,
  T.Null,
  T.RParen,
  T.RBrack,
  T.RBrace,
]);
const VALUE_START = new Set<number>([
  T.Ident,
  T.Num,
  T.Str,
  T.StateVar,
  T.True,
  T.False,
  T.Null,
  T.Type,
  T.BuiltinCall,
  T.Not,
]);

export type Edit = { readonly source: string; readonly id?: string } | { readonly error: string };

/** Where a component is referenced: item `index` of `prop` on statement `parent`. */
export interface Location {
  readonly parent: string;
  readonly prop: string;
  readonly index: number;
}

// ---------------------------------------------------------------- segments and statements

interface Seg {
  /** The segment's exact text, comments included, without its line ending. */
  text: string;
  /** The text with comments cut out, for the lexer. */
  code: string;
  /** The line ending that followed it: "\n", or "" for the last segment. */
  eol: string;
}

function segments(source: string): Seg[] {
  const segs: Seg[] = [];
  let text = '';
  let code = '';
  let depth = 0;
  let quote = '';
  let comment = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] ?? '';
    if (comment && c !== '\n') {
      text += c;
      continue;
    }
    if (quote !== '') {
      text += c;
      code += c;
      if (c === '\\') {
        const next = source[i + 1] ?? '';
        text += next;
        code += next;
        i += 1;
      } else if (c === quote) quote = '';
      continue;
    }
    if (c === '\n') {
      comment = false;
      if (depth <= 0) {
        segs.push({ text, code, eol: '\n' });
        text = '';
        code = '';
        depth = 0;
        continue;
      }
    } else if (c === '/' && source[i + 1] === '/') {
      comment = true;
      text += c;
      continue;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    text += c;
    code += c;
  }
  segs.push({ text, code, eol: '' });
  return segs;
}

const join = (segs: readonly Seg[]): string => segs.map((seg) => seg.text + seg.eol).join('');

const lexed = (text: string): Token[] =>
  (tokenize(text) as Token[]).filter((token) => token.t !== T.Newline && token.t !== T.EOF);

interface Stmt {
  readonly index: number;
  readonly id: string;
  /** Everything after `id =`. */
  readonly rhs: Token[];
}

function table(segs: readonly Seg[]): Stmt[] {
  const out: Stmt[] = [];
  segs.forEach((seg, index) => {
    const tokens = lexed(seg.code);
    const head = tokens[0];
    if (
      tokens.length >= 3 &&
      head &&
      (head.t === T.Ident || head.t === T.Type || head.t === T.StateVar) &&
      tokens[1]?.t === T.Equals
    )
      out.push({ index, id: String(head.v), rhs: tokens.slice(2) });
  });
  return out;
}

const find = (stmts: readonly Stmt[], id: string): Stmt | undefined =>
  stmts.find((stmt) => stmt.id === id);

/** The index of the bracket that closes the one at `at`, or -1. */
function closing(tokens: readonly Token[], at: number): number {
  let depth = 0;
  for (let i = at; i < tokens.length; i += 1) {
    const t = tokens[i]?.t ?? -1;
    if (OPEN.has(t)) depth += 1;
    else if (CLOSE.has(t)) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The parts of a token run between its depth-0 commas. */
function splitTop(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (OPEN.has(token.t)) depth += 1;
    else if (CLOSE.has(token.t)) depth -= 1;
    if (token.t === T.Comma && depth === 0) {
      parts.push(current);
      current = [];
    } else current.push(token);
  }
  if (current.length > 0 || parts.length > 0) parts.push(current);
  if (parts.length > 0 && parts[parts.length - 1]?.length === 0) parts.pop();
  return parts;
}

interface Call {
  name: string;
  args: Token[][];
}

function callOf(rhs: readonly Token[]): Call | null {
  const head = rhs[0];
  if (head?.t !== T.Type || rhs[1]?.t !== T.LParen || closing(rhs, 1) !== rhs.length - 1)
    return null;
  return { name: String(head.v), args: splitTop(rhs.slice(2, -1)) };
}

/** The elements of a `[a, b]` literal, or null when the tokens are anything else. */
function listOf(arg: readonly Token[]): Token[][] | null {
  if (arg[0]?.t !== T.LBrack || closing(arg, 0) !== arg.length - 1) return null;
  return splitTop(arg.slice(1, -1));
}

const isNull = (arg: readonly Token[]): boolean =>
  arg.length === 0 || (arg.length === 1 && arg[0]?.t === T.Null);

const listTokens = (elements: readonly Token[][]): Token[] => [
  tok(T.LBrack),
  ...elements.flatMap((el, i) => (i === 0 ? el : [tok(T.Comma), ...el])),
  tok(T.RBrack),
];

/** A call as tokens; trailing absent arguments are dropped, middle ones become null. */
function callTokens(call: Call): Token[] {
  const args = [...call.args];
  while (args.length > 0 && isNull(args[args.length - 1] ?? [])) args.pop();
  return [
    tok(T.Type, call.name),
    tok(T.LParen),
    ...args.flatMap((arg, i) => {
      const part = arg.length === 0 ? [tok(T.Null)] : arg;
      return i === 0 ? part : [tok(T.Comma), ...part];
    }),
    tok(T.RParen),
  ];
}

// ---------------------------------------------------------------- printing

const BARE = new Set<number>([T.RParen, T.RBrack, T.RBrace, T.Comma, T.Dot]);
const HUG_NEXT = new Set<number>([T.LParen, T.LBrack, T.LBrace, T.Dot, T.Not]);

/** Tokens as readable text. Strings are JSON, which the lexer reads back unchanged. */
export function printTokens(tokens: readonly Token[]): string {
  let out = '';
  const open: number[] = [];
  let prev: Token | undefined;
  let tight = false;
  for (const token of tokens) {
    const t = token.t;
    let gap = ' ';
    if (prev === undefined || tight || BARE.has(t) || HUG_NEXT.has(prev.t)) gap = '';
    else if (t === T.Colon) gap = open[open.length - 1] === T.LBrace ? '' : ' ';
    else if (t === T.LParen) gap = oneOf(prev.t, T.Type, T.BuiltinCall, T.Ident) ? '' : ' ';
    else if (t === T.LBrack) gap = oneOf(prev.t, T.Ident, T.RBrack, T.RParen) ? '' : ' ';
    // A minus after an operand subtracts; anywhere else it negates and hugs what follows.
    tight = t === T.Minus && (prev === undefined || !VALUE_END.has(prev.t));
    if (OPEN.has(t)) open.push(t);
    else if (CLOSE.has(t)) open.pop();
    const text =
      t === T.Str
        ? JSON.stringify(token.v)
        : t === T.BuiltinCall
          ? `@${String(token.v)}`
          : t === T.Num || t === T.Ident || t === T.Type || t === T.StateVar
            ? String(token.v)
            : PUNCTUATION[t];
    if (text === undefined) throw new Error(`Cannot print token ${String(t)}.`);
    out += gap + text;
    prev = token;
  }
  return out;
}

const PUNCTUATION: Record<number, string> = {
  [T.LParen]: '(',
  [T.RParen]: ')',
  [T.LBrack]: '[',
  [T.RBrack]: ']',
  [T.LBrace]: '{',
  [T.RBrace]: '}',
  [T.Comma]: ',',
  [T.Colon]: ':',
  [T.Equals]: '=',
  [T.True]: 'true',
  [T.False]: 'false',
  [T.Null]: 'null',
  [T.Dot]: '.',
  [T.Plus]: '+',
  [T.Minus]: '-',
  22: '*',
  23: '/',
  24: '%',
  25: '==',
  26: '!=',
  27: '>',
  28: '<',
  29: '>=',
  30: '<=',
  31: '&&',
  32: '||',
  [T.Not]: '!',
  [T.Question]: '?',
};

const statementText = (id: string, rhs: readonly Token[]): string => `${id} = ${printTokens(rhs)}`;

// ---------------------------------------------------------------- expressions

/** Why a piece of text is not one expression, or null when it is. `parseExpression` never
 * throws and quietly drops what it cannot read, so the shape is checked here first. */
export function checkExpression(text: string): string | null {
  const tokens = lexed(text);
  if (tokens.length === 0) return 'Enter a value.';
  const stack: number[] = [];
  let prev: Token | undefined;
  for (const token of tokens) {
    const t = token.t;
    if (OPEN.has(t)) stack.push(t);
    else if (CLOSE.has(t)) {
      const top = stack.pop();
      if (top === undefined || CLOSE_OF[top] !== t) return 'The brackets do not match.';
    } else if (stack.length === 0 && t === T.Comma) return 'Enter one value, without a comma.';
    else if (stack.length === 0 && t === T.Equals)
      return 'Use == to compare; = starts a statement.';
    if (prev && VALUE_END.has(prev.t) && VALUE_START.has(t))
      return `A value is missing an operator or comma before ${printTokens([token])}.`;
    prev = token;
  }
  if (stack.length > 0) return 'A bracket is not closed.';
  const last = tokens[tokens.length - 1]?.t ?? -1;
  const first = tokens[0]?.t ?? -1;
  if (
    BINARY.has(last) ||
    oneOf(last, T.Comma, T.Colon, T.Dot, T.Not, T.Question) ||
    (BINARY.has(first) && first !== T.Minus)
  )
    return 'The expression is not finished.';
  return parseExpression(tokens).k === 'Null' && tokens[0]?.t !== T.Null
    ? 'That is not a value.'
    : null;
}

const CLOSE_OF: Record<number, number> = {
  [T.LParen]: T.RParen,
  [T.LBrack]: T.RBrack,
  [T.LBrace]: T.RBrace,
};

// ---------------------------------------------------------------- the contracts, as props

export interface PropInfo {
  readonly name: string;
  /** Position among the component's positional arguments. */
  readonly index: number;
  readonly kind:
    'string' | 'number' | 'boolean' | 'enum' | 'children' | 'slot' | 'array' | 'object' | 'other';
  readonly optional: boolean;
  /** Bound to a `$variable` rather than given a value. */
  readonly reactive: boolean;
  readonly options?: readonly string[];
}

interface ZodDef {
  type: string;
  innerType?: ZodLike;
  element?: ZodLike;
  entries?: Record<string, string>;
  options?: ZodLike[];
}
interface ZodLike {
  def: ZodDef;
}

function infoOf(name: string, index: number, schema: ZodLike): PropInfo {
  let inner = schema;
  let optional = false;
  while (inner.def.innerType) {
    optional = optional || inner.def.type === 'optional';
    inner = inner.def.innerType;
  }
  const def = inner.def;
  const scalar =
    def.type === 'union' &&
    (def.options ?? []).every((option) => ['string', 'number'].includes(option.def.type));
  const kind: PropInfo['kind'] =
    def.type === 'string' || scalar
      ? 'string'
      : def.type === 'number'
        ? 'number'
        : def.type === 'boolean'
          ? 'boolean'
          : def.type === 'enum'
            ? 'enum'
            : def.type === 'array'
              ? def.element?.def.type === 'any'
                ? 'children'
                : 'array'
              : def.type === 'any'
                ? 'slot'
                : def.type === 'object'
                  ? 'object'
                  : 'other';
  return {
    name,
    index,
    kind,
    optional,
    reactive: isReactiveSchema(schema),
    ...(def.entries ? { options: Object.keys(def.entries) } : {}),
  };
}

const propCache = new Map<string, readonly PropInfo[]>();

/** A component's props in positional order; empty for a name the library does not know. */
export function propsOf(type: string): readonly PropInfo[] {
  const cached = propCache.get(type);
  if (cached) return cached;
  const contract = (CONTRACTS as Record<string, (typeof CONTRACTS)[ContractName] | undefined>)[
    type
  ];
  const shape = contract
    ? (contract.props as unknown as { shape: Record<string, ZodLike> }).shape
    : {};
  const infos = Object.entries(shape).map(([name, schema], index) => infoOf(name, index, schema));
  propCache.set(type, infos);
  return infos;
}

export const isComponent = (type: string): boolean => propsOf(type).length > 0;
export const isContainer = (type: string): boolean =>
  propsOf(type).some((prop) => prop.kind === 'children');

export const PALETTE: readonly {
  readonly label: string;
  readonly components: readonly string[];
}[] = [
  { label: 'Layout', components: ['Stack', 'Row', 'Grid', 'Card', 'Form'] },
  { label: 'Content', components: ['Text', 'Stat', 'Button'] },
  {
    label: 'Inputs',
    components: ['NumberInput', 'TextInput', 'TextArea', 'Select', 'Slider', 'Toggle'],
  },
  { label: 'Data', components: ['Table', 'Chart', 'ItemList'] },
];

// ---------------------------------------------------------------- the component tree

interface Slot {
  readonly prop: string;
  readonly kind: 'children' | 'slot';
  /** The elements of a literal list; null when the prop is computed (`@Each(...)`, a name). */
  readonly elements: Token[][] | null;
}

function slotsOf(call: Call): Slot[] {
  return propsOf(call.name)
    .filter((prop) => prop.kind === 'children' || prop.kind === 'slot')
    .map((prop) => {
      const arg = call.args[prop.index] ?? [];
      const kind = prop.kind as 'children' | 'slot';
      return {
        prop: prop.name,
        kind,
        elements: kind === 'slot' ? (isNull(arg) ? [] : [arg]) : isNull(arg) ? [] : listOf(arg),
      };
    });
}

const refOf = (element: readonly Token[]): string | null =>
  element.length === 1 && element[0]?.t === T.Ident ? String(element[0].v) : null;

export interface OutlineNode {
  /** Unique within the outline, for React. */
  readonly key: string;
  /** The statement that defines it; null for an inline component or an expression. */
  readonly id: string | null;
  /** The component name, or a short description for something that is not a component. */
  readonly type: string;
  readonly kind: 'component' | 'inline' | 'other';
  readonly at: Location | null;
  readonly children: readonly OutlineNode[];
}

/** The structure under `root`, or null when there is no component root. */
export function outline(source: string): OutlineNode | null {
  const stmts = table(segments(source));
  const build = (id: string, at: Location | null, path: readonly string[]): OutlineNode => {
    const stmt = find(stmts, id);
    const call = stmt ? callOf(stmt.rhs) : null;
    const key = at ? `${at.parent}.${at.prop}.${String(at.index)}` : id;
    if (!call || !isComponent(call.name))
      return {
        key,
        id: null,
        type: stmt ? 'expression' : `${id} (missing)`,
        kind: 'other',
        at,
        children: [],
      };
    const children: OutlineNode[] = [];
    for (const slot of slotsOf(call))
      (slot.elements ?? []).forEach((element, index) => {
        const where = { parent: id, prop: slot.prop, index };
        const name = refOf(element);
        const inline = callOf(element);
        const k = `${id}.${slot.prop}.${String(index)}`;
        if (name !== null && !path.includes(name)) children.push(build(name, where, [...path, id]));
        else if (inline && isComponent(inline.name))
          children.push({
            key: k,
            id: null,
            type: inline.name,
            kind: 'inline',
            at: where,
            children: [],
          });
        else
          children.push({
            key: k,
            id: null,
            type: name ?? 'expression',
            kind: 'other',
            at: where,
            children: [],
          });
      });
    return { key, id, type: call.name, kind: 'component', at, children };
  };
  const root = find(stmts, 'root');
  if (!root || !callOf(root.rhs) || !isComponent(callOf(root.rhs)?.name ?? '')) return null;
  return build('root', null, []);
}

/** Every reference to `id` in a literal child list, in program order. */
function references(stmts: readonly Stmt[], id: string): Location[] {
  const found: Location[] = [];
  for (const stmt of stmts) {
    const call = callOf(stmt.rhs);
    if (!call) continue;
    for (const slot of slotsOf(call))
      (slot.elements ?? []).forEach((element, index) => {
        if (refOf(element) === id) found.push({ parent: stmt.id, prop: slot.prop, index });
      });
  }
  return found;
}

export function locate(source: string, id: string): Location | null {
  return references(table(segments(source)), id)[0] ?? null;
}

/** The statements under `id`, itself excluded. */
function descendants(stmts: readonly Stmt[], id: string, seen = new Set<string>()): Set<string> {
  const call = callOf(find(stmts, id)?.rhs ?? []);
  for (const slot of call ? slotsOf(call) : [])
    for (const element of slot.elements ?? []) {
      const name = refOf(element);
      if (name !== null && !seen.has(name)) {
        seen.add(name);
        descendants(stmts, name, seen);
      }
    }
  return seen;
}

// ---------------------------------------------------------------- reading a statement

export interface PropView {
  readonly info: PropInfo;
  /** The argument as code; empty when the prop is not given. */
  readonly text: string;
  /** The value when the argument is a single string, number or boolean literal. */
  readonly literal: string | number | boolean | undefined;
  /** For a child list: how many it holds, or null when it is computed. */
  readonly count: number | null;
}

export interface Description {
  readonly id: string;
  readonly type: string;
  readonly props: readonly PropView[];
}

function literalOf(arg: readonly Token[]): string | number | boolean | undefined {
  const only = arg.length === 1 ? arg[0] : undefined;
  if (only?.t === T.Str || only?.t === T.Num) return only.v;
  if (only?.t === T.True) return true;
  if (only?.t === T.False) return false;
  return undefined;
}

export function describe(source: string, id: string): Description | null {
  const stmt = find(table(segments(source)), id);
  const call = stmt ? callOf(stmt.rhs) : null;
  if (!call || !isComponent(call.name)) return null;
  return {
    id,
    type: call.name,
    props: propsOf(call.name).map((info) => {
      const arg = call.args[info.index] ?? [];
      const elements = info.kind === 'children' ? (isNull(arg) ? [] : listOf(arg)) : null;
      return {
        info,
        text: isNull(arg) ? '' : printTokens(arg),
        literal: literalOf(arg),
        count: elements ? elements.length : null,
      };
    }),
  };
}

export interface DataStatement {
  readonly id: string;
  readonly kind: 'query' | 'mutation' | 'state' | 'other';
  /** The right-hand side, as code. */
  readonly text: string;
}

/** The statements that are not components: queries, mutations and `$state`. */
export function dataOf(source: string): DataStatement[] {
  return table(segments(source)).flatMap((stmt) => {
    const call = callOf(stmt.rhs);
    if (call && isComponent(call.name)) return [];
    const kind =
      call?.name === 'Query'
        ? 'query'
        : call?.name === 'Mutation'
          ? 'mutation'
          : stmt.id.startsWith('$')
            ? 'state'
            : 'other';
    return [{ id: stmt.id, kind, text: printTokens(stmt.rhs) } as const];
  });
}

// ---------------------------------------------------------------- editing

const fail = (error: string): { error: string } => ({ error });

function usedNames(segs: readonly Seg[]): Set<string> {
  const used = new Set<string>();
  for (const seg of segs)
    for (const token of lexed(seg.code))
      if (oneOf(token.t, T.Ident, T.Type, T.StateVar)) used.add(String(token.v));
  return used;
}

function freeName(base: string, used: ReadonlySet<string>): string {
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = `${base}${String(n)}`;
  return name;
}

const camel = (type: string): string => (type[0] ?? '').toLowerCase() + type.slice(1);

function put(segs: Seg[], index: number, text: string): void {
  const seg = segs[index];
  if (seg) segs[index] = { ...seg, text, code: text };
}

function insertAfter(segs: Seg[], index: number, texts: readonly string[]): void {
  const at = segs[index];
  if (!at) return;
  // A new line follows the segment; the last segment gains an ending and its successor loses it.
  const fresh = texts.map((text): Seg => ({ text, code: text, eol: '\n' }));
  if (at.eol === '') {
    segs[index] = { ...at, eol: '\n' };
    const last = fresh[fresh.length - 1];
    if (last) last.eol = '';
  }
  segs.splice(index + 1, 0, ...fresh);
}

function removeSeg(segs: Seg[], index: number): void {
  const [gone] = segs.splice(index, 1);
  const before = segs[index - 1];
  if (gone?.eol === '' && before) segs[index - 1] = { ...before, eol: '' };
}

/** Rewrites one component's slot: `change` gets the current elements and returns the new ones. */
function editSlot(
  segs: Seg[],
  parent: string,
  prop: string,
  change: (elements: Token[][]) => Token[][] | string,
): string | null {
  const stmt = find(table(segs), parent);
  const call = stmt ? callOf(stmt.rhs) : null;
  const info = propsOf(call?.name ?? '').find((candidate) => candidate.name === prop);
  if (!stmt || !call || !info || (info.kind !== 'children' && info.kind !== 'slot'))
    return `${parent} has no ${prop} to change.`;
  const slot = slotsOf(call).find((candidate) => candidate.prop === prop);
  if (slot?.elements == null)
    return `${prop} of ${parent} is computed, so it cannot be arranged here.`;
  const next = change(slot.elements);
  if (typeof next === 'string') return next;
  while (call.args.length <= info.index) call.args.push([]);
  call.args[info.index] = info.kind === 'slot' ? (next[0] ?? []) : listTokens(next);
  put(segs, stmt.index, statementText(stmt.id, callTokens(call)));
  return null;
}

/** Removes a statement, then those only it referenced; the root is never removed. */
function prune(segs: Seg[], id: string): void {
  if (id === 'root') return;
  const stmts = table(segs);
  const stmt = find(stmts, id);
  if (!stmt) return;
  const others = stmts.filter((other) => other.id !== id);
  // Any mention counts as a reference (a name used in an expression too), so nothing in use goes.
  if (others.some((other) => other.rhs.some((t) => t.t === T.Ident && t.v === id))) return;
  const call = callOf(stmt.rhs);
  const kids = (call && isComponent(call.name) ? slotsOf(call) : [])
    .flatMap((slot) => slot.elements ?? [])
    .flatMap((element) => refOf(element) ?? []);
  removeSeg(segs, stmt.index);
  for (const kid of kids) prune(segs, kid);
}

function applyProps(segs: Seg[], id: string, values: Record<string, string>): string | null {
  const stmt = find(table(segs), id);
  const call = stmt ? callOf(stmt.rhs) : null;
  if (!stmt || !call || !isComponent(call.name)) return `${id} is not a component.`;
  for (const [name, text] of Object.entries(values)) {
    const info = propsOf(call.name).find((candidate) => candidate.name === name);
    if (!info) return `${call.name} has no ${name}.`;
    const blank = text.trim() === '';
    if (blank && !info.optional) return `${name} is required.`;
    const problem = blank ? null : checkExpression(text);
    if (problem) return problem;
    while (call.args.length <= info.index) call.args.push([]);
    call.args[info.index] = blank ? [] : lexed(text);
  }
  put(segs, stmt.index, statementText(stmt.id, callTokens(call)));
  return null;
}

/** Sets one prop of a component to an expression (a literal is an expression: `"Hi"`, `3`).
 * Blank clears an optional prop. */
export function setProp(source: string, id: string, prop: string, text: string): Edit {
  const segs = segments(source);
  const error = applyProps(segs, id, { [prop]: text });
  return error ? fail(error) : { source: join(segs) };
}

/** Replaces the right-hand side of any statement: a query, a mutation, a `$state` value. */
export function setStatement(source: string, id: string, text: string): Edit {
  const segs = segments(source);
  const stmt = find(table(segs), id);
  if (!stmt) return fail(`${id} is not defined.`);
  const problem = checkExpression(text);
  if (problem) return fail(problem);
  put(segs, stmt.index, statementText(id, lexed(text)));
  return { source: join(segs) };
}

// ---- defaults for a new component

const LABELS: Record<string, string> = {
  label: 'Label',
  title: 'Title',
  caption: 'Caption',
  value: 'Value',
  name: 'form',
};

function defaultFor(
  type: string,
  info: PropInfo,
  source: string,
  used: Set<string>,
  extra: string[],
): Token[] {
  if (info.reactive) {
    const name = freeName(`$${camel(type)}`, used);
    used.add(name);
    const start = info.kind === 'number' ? '0' : info.kind === 'boolean' ? 'false' : '""';
    extra.push(`${name} = ${start}`);
    return [tok(T.StateVar, name)];
  }
  switch (info.kind) {
    case 'string': {
      let text = type === 'Text' && info.name === 'value' ? 'Text' : (LABELS[info.name] ?? '');
      // Two inputs with one label would share a state key, so a label stays unique.
      if (info.name === 'label' && type !== 'Stat')
        for (let n = 2; source.includes(JSON.stringify(text)); n += 1) text = `Label ${String(n)}`;
      return [tok(T.Str, text)];
    }
    case 'number':
      return [tok(T.Num, info.name === 'max' ? 100 : info.name === 'columns' ? 2 : 0)];
    case 'boolean':
      return [tok(T.False)];
    case 'enum':
      return [tok(T.Str, info.options?.[0] ?? '')];
    case 'children':
    case 'array':
      return [tok(T.LBrack), tok(T.RBrack)];
    case 'object':
      return [tok(T.LBrace), tok(T.RBrace)];
    case 'slot': {
      // A Form's submit is a Button of its own.
      const name = freeName('submit', used);
      used.add(name);
      extra.push(`${name} = Button("Submit", @Reset())`);
      return [tok(T.Ident, name)];
    }
    default:
      // The only other required prop is a Button's action; @Reset is a harmless stand-in to edit.
      return [tok(T.BuiltinCall, 'Reset'), tok(T.LParen), tok(T.RParen)];
  }
}

/** Adds a new component as item `index` (default: last) of a container's child list. */
export function addComponent(
  source: string,
  to: { readonly parent: string; readonly prop?: string; readonly index?: number },
  type: string,
): Edit {
  if (!isComponent(type)) return fail(`${type} is not a component.`);
  const segs = segments(source);
  const stmt = find(table(segs), to.parent);
  const parentCall = stmt ? callOf(stmt.rhs) : null;
  const prop =
    to.prop ??
    propsOf(parentCall?.name ?? '').find((candidate) => candidate.kind === 'children')?.name;
  if (!stmt || !prop) return fail('Components can only go inside a container.');
  const used = usedNames(segs);
  const id = freeName(camel(type), used);
  used.add(id);
  const extra: string[] = [];
  const infos = propsOf(type);
  const needed = infos.reduce((last, info) => (info.optional ? last : info.index), -1);
  const call: Call = {
    name: type,
    args: infos
      .slice(0, needed + 1)
      .map((info) => (info.optional ? [] : defaultFor(type, info, source, used, extra))),
  };
  const error = editSlot(segs, to.parent, prop, (elements) => {
    const at = Math.min(Math.max(to.index ?? elements.length, 0), elements.length);
    return [...elements.slice(0, at), [tok(T.Ident, id)], ...elements.slice(at)];
  });
  if (error) return fail(error);
  insertAfter(segs, stmt.index, [statementText(id, callTokens(call)), ...extra]);
  return { source: join(segs), id };
}

const REQUIRED = 'A form needs its submit button; change it in the inspector.';

/** Whether a reference sits in a single required slot (a Form's submit) rather than a list. */
function isSlot(stmts: readonly Stmt[], at: Location): boolean {
  const call = callOf(find(stmts, at.parent)?.rhs ?? []);
  return propsOf(call?.name ?? '').find((p) => p.name === at.prop)?.kind === 'slot';
}

/** Moves a component to item `index` of a container's child list (counted after it is lifted
 * out), within its container or into another. */
export function moveComponent(
  source: string,
  id: string,
  to: { readonly parent: string; readonly prop?: string; readonly index: number },
): Edit {
  if (id === 'root') return fail('The root stays where it is.');
  const segs = segments(source);
  const stmts = table(segs);
  const from = references(stmts, id)[0];
  if (!from) return fail(`${id} is not in the layout.`);
  if (to.parent === id || descendants(stmts, id).has(to.parent))
    return fail('A component cannot go inside itself.');
  const target = callOf(find(stmts, to.parent)?.rhs ?? []);
  const prop =
    to.prop ?? propsOf(target?.name ?? '').find((candidate) => candidate.kind === 'children')?.name;
  if (!target || !prop || !isContainer(target.name))
    return fail('Components can only go inside a container.');
  const info = propsOf(target.name).find((candidate) => candidate.name === prop);
  if (info?.kind !== 'children') return fail(`${to.parent} cannot hold other components there.`);
  if (isSlot(stmts, from)) return fail(REQUIRED);
  const taken = editSlot(segs, from.parent, from.prop, (elements) =>
    elements.filter((_, index) => index !== from.index),
  );
  if (taken) return fail(taken);
  const placed = editSlot(segs, to.parent, prop, (elements) => {
    const at = Math.min(Math.max(to.index, 0), elements.length);
    return [...elements.slice(0, at), [tok(T.Ident, id)], ...elements.slice(at)];
  });
  return placed ? fail(placed) : { source: join(segs) };
}

/** Removes a component from its container, and its statement once nothing refers to it. */
export function deleteComponent(source: string, id: string): Edit {
  if (id === 'root') return fail('The root cannot be deleted.');
  const segs = segments(source);
  const from = references(table(segs), id)[0];
  if (!from) return fail(`${id} is not in the layout.`);
  if (isSlot(table(segs), from)) return fail(REQUIRED);
  const error = editSlot(segs, from.parent, from.prop, (elements) =>
    elements.filter((_, index) => index !== from.index),
  );
  if (error) return fail(error);
  prune(segs, id);
  return { source: join(segs) };
}

/** Gives an inline component its own statement, so it can be selected and edited. */
export function liftInline(source: string, at: Location): Edit {
  const segs = segments(source);
  const stmt = find(table(segs), at.parent);
  const call = stmt ? callOf(stmt.rhs) : null;
  const slot = call ? slotsOf(call).find((candidate) => candidate.prop === at.prop) : undefined;
  const element = slot?.elements?.[at.index];
  const inline = element ? callOf(element) : null;
  if (!stmt || !element || !inline || !isComponent(inline.name))
    return fail('That is not an inline component.');
  const used = usedNames(segs);
  const id = freeName(camel(inline.name), used);
  const error = editSlot(segs, at.parent, at.prop, (elements) =>
    elements.map((candidate, index) => (index === at.index ? [tok(T.Ident, id)] : candidate)),
  );
  if (error) return fail(error);
  insertAfter(segs, stmt.index, [statementText(id, element)]);
  return { source: join(segs), id };
}

// ---- the collection helper

const ITEMS_QUERY = 'Query("list_items", {parentId: $container}, {items: []})';

function existingItemsQuery(segs: readonly Seg[]): string | undefined {
  return table(segs).find((stmt) => {
    const call = callOf(stmt.rhs);
    return call?.name === 'Query' && call.args[0]?.[0]?.v === 'list_items';
  })?.id;
}

/** Appends `items = Query(...)` under a free name and returns the name. */
function appendItemsQuery(segs: Seg[]): string {
  const id = freeName('items', usedNames(segs));
  const last = segs.length - 1;
  if ((segs[last]?.text ?? '').trim() === '') put(segs, last, `${id} = ${ITEMS_QUERY}`);
  else insertAfter(segs, last, [`${id} = ${ITEMS_QUERY}`]);
  return id;
}

/** Adds `items = Query("list_items", {parentId: $container}, {items: []})` under a free name. */
export function addItemsQuery(source: string): Edit {
  const segs = segments(source);
  const id = appendItemsQuery(segs);
  return { source: join(segs), id };
}

/** What a Table, ItemList or Chart can show of the collection's items. */
export const ITEM_BINDINGS: Record<string, (query: string) => Record<string, string>> = {
  Table: (q) => ({
    columns: '["Title", "Type"]',
    rows: `@Each(${q}.items, "item", [item.title, item.type])`,
  }),
  ItemList: (q) => ({ items: `${q}.items` }),
  Chart: (q) => ({
    labels: `@Each(${q}.items, "item", item.title)`,
    series: `[{label: "Items", values: @Each(${q}.items, "item", 1)}]`,
  }),
};

/** Points a Table, ItemList or Chart at the collection's items, adding the query if needed. */
export function bindItems(source: string, id: string): Edit {
  const segs = segments(source);
  const type = callOf(find(table(segs), id)?.rhs ?? [])?.name ?? '';
  const bind = ITEM_BINDINGS[type];
  if (!bind) return fail(`${type || id} cannot show items.`);
  const error = applyProps(segs, id, bind(existingItemsQuery(segs) ?? appendItemsQuery(segs)));
  return error ? fail(error) : { source: join(segs) };
}
