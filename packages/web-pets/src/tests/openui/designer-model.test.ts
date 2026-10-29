import { createParser } from '@openuidev/react-lang';
import { tokenize } from '@openuidev/lang-core';
import { describe, expect, it } from 'vitest';

import { nixLibrary } from '../../openui/library';
import {
  addComponent,
  addItemsQuery,
  bindItems,
  checkExpression,
  dataOf,
  deleteComponent,
  describe as describeComponent,
  liftInline,
  moveComponent,
  outline,
  PALETTE,
  printTokens,
  propsOf,
  setProp,
  setStatement,
  type Edit,
  type OutlineNode,
} from '../../openui/designer-model';

const parser = createParser(nixLibrary.toJSONSchema());

const PROGRAM = [
  '// A small dashboard',
  'root = Stack([title, card, add]) // the top',
  'title = Text("Hello",   "title")',
  '$n = 0',
  'card = Card("Stats", [',
  '  stat,',
  '  Text("inline", "note")',
  '])',
  'stat = Stat("Total", $n  +  1, "pts")   // keep my spacing',
  'add = Button("Add", @Set($n, $n + 1), "primary")',
  'rows = Query("list_items", {parentId: "p"}, {items: []})',
  '',
].join('\n');

function ok(edit: Edit): { source: string; id?: string } {
  if ('error' in edit) throw new Error(edit.error);
  return edit;
}

/** The program's lines without the statements named: what an edit must leave alone. */
function without(source: string, ids: readonly string[]): string[] {
  const lines = source.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const head = /^([$\w]+) =/.exec(line)?.[1];
    if (head !== undefined) skipping = ids.includes(head);
    else if (!line.startsWith(' ') && !line.startsWith(']')) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept;
}

function errors(source: string): string[] {
  const result = parser.parse(source);
  return result.meta.errors.map((error) => error.message);
}

function flat(node: OutlineNode | null): string[] {
  return node ? [node.id ?? node.type, ...node.children.flatMap((child) => flat(child))] : [];
}

describe('the program the tests start from', () => {
  it('parses cleanly, comments and all', () => {
    expect(errors(PROGRAM)).toEqual([]);
    expect(flat(outline(PROGRAM))).toEqual(['root', 'title', 'card', 'stat', 'Text', 'add']);
  });
});

describe('printing', () => {
  const same = (text: string) => {
    const kinds = (source: string) =>
      (tokenize(source) as { t: number }[]).filter((token) => token.t !== 0 && token.t !== 13);
    const tokens = kinds(text);
    const printed = printTokens(tokens);
    expect(kinds(printed)).toEqual(tokens);
    return printed;
  };

  it('reads back as the same tokens', () => {
    expect(same('Stack([a,b],  {x:1,y:[2,3]})')).toBe('Stack([a, b], {x: 1, y: [2, 3]})');
    expect(same('@Each(rows.items,"i",[i.title,-i.n,a-1,!b])')).toBe(
      '@Each(rows.items, "i", [i.title, -i.n, a - 1, !b])',
    );
    expect(same('a?b:c')).toBe('a ? b : c');
    expect(same('x[0] == "q\\"\\n" && y >= -2.5 || z != null')).toContain('-2.5');
    expect(same("Text('single', true, false)")).toBe('Text("single", true, false)');
  });
});

describe('checkExpression', () => {
  it('accepts one expression and says what is wrong with anything else', () => {
    for (const fine of [
      '"Hi"',
      '3',
      '$n + 1',
      'rows.items',
      '@Each(a.items, "i", [i.title])',
      '[1, 2]',
    ])
      expect(checkExpression(fine), fine).toBeNull();
    for (const bad of ['', 'a b', 'a +', '(a', 'a, b', '"x" "y"', 'x = 1'])
      expect(checkExpression(bad), bad).not.toBeNull();
  });
});

describe('setProp', () => {
  it('rewrites only the edited statement, and leaves the others byte for byte', () => {
    const { source } = ok(setProp(PROGRAM, 'title', 'value', '"Goodbye"'));
    expect(source).toContain('title = Text("Goodbye", "title")');
    expect(without(source, ['title'])).toEqual(without(PROGRAM, ['title']));
    // the comment on an untouched line and the odd spacing of another statement survive
    expect(source).toContain('stat = Stat("Total", $n  +  1, "pts")   // keep my spacing');
    expect(source.split('\n')[0]).toBe('// A small dashboard');
    expect(errors(source)).toEqual([]);
  });

  it('keeps expression arguments of the edited statement as the same tokens', () => {
    const { source } = ok(setProp(PROGRAM, 'stat', 'label', '"Sum"'));
    expect(source).toContain('stat = Stat("Sum", $n + 1, "pts")');
    const { source: again } = ok(setProp(PROGRAM, 'add', 'label', '"Plus"'));
    expect(again).toContain('add = Button("Plus", @Set($n, $n + 1), "primary")');
    expect(without(again, ['add'])).toEqual(without(PROGRAM, ['add']));
  });

  it('sets a prop past the end with nulls between, and clears an optional one', () => {
    const base = 'root = Stack([t])\nt = Text("x")';
    const set = ok(setProp(base, 't', 'tone', '"muted"')).source;
    expect(set).toContain('t = Text("x", null, "muted")');
    expect(errors(set)).toEqual([]);
    expect(ok(setProp(set, 't', 'tone', '')).source).toBe(base);
  });

  it('refuses text that is not one expression, a required prop left blank, and unknown props', () => {
    expect(setProp(PROGRAM, 'title', 'value', 'a b')).toHaveProperty('error');
    expect(setProp(PROGRAM, 'title', 'value', '')).toEqual({ error: 'value is required.' });
    expect(setProp(PROGRAM, 'title', 'nope', '1')).toHaveProperty('error');
    expect(setProp(PROGRAM, 'rows', 'x', '1')).toEqual({ error: 'rows is not a component.' });
  });
});

describe('describe', () => {
  it('reads literals, expressions and child counts', () => {
    const stat = describeComponent(PROGRAM, 'stat');
    expect(stat?.props.map((prop) => [prop.info.name, prop.text, prop.literal])).toEqual([
      ['label', '"Total"', 'Total'],
      ['value', '$n + 1', undefined],
      ['unit', '"pts"', 'pts'],
    ]);
    expect(describeComponent(PROGRAM, 'card')?.props[1]?.count).toBe(2);
    expect(describeComponent(PROGRAM, 'rows')).toBeNull();
  });

  it('lists the data statements', () => {
    expect(dataOf(PROGRAM).map((data) => [data.id, data.kind])).toEqual([
      ['$n', 'state'],
      ['rows', 'query'],
    ]);
  });
});

describe('addComponent', () => {
  it('adds a statement with a free name and its required props, after the container', () => {
    const edit = ok(addComponent(PROGRAM, { parent: 'root', index: 1 }, 'Text'));
    expect(edit.id).toBe('text');
    expect(flat(outline(edit.source))).toEqual([
      'root',
      'title',
      'text',
      'card',
      'stat',
      'Text',
      'add',
    ]);
    expect(edit.source).toContain('text = Text("Text")');
    expect(errors(edit.source)).toEqual([]);
    expect(without(edit.source, ['root', 'text'])).toEqual(without(PROGRAM, ['root']));
    const second = ok(addComponent(edit.source, { parent: 'root' }, 'Text'));
    expect(second.id).toBe('text2');
  });

  it('gives every component in the palette a default that parses', () => {
    expect(PALETTE.flatMap((group) => group.components)).toHaveLength(17);
    for (const type of PALETTE.flatMap((group) => group.components)) {
      const added = ok(addComponent('root = Stack([])', { parent: 'root' }, type));
      expect(errors(added.source), added.source).toEqual([]);
      expect(flat(outline(added.source)).length, added.source).toBeGreaterThan(1);
    }
  });

  it('binds an input to a new $state and keeps labels apart', () => {
    let source = 'root = Stack([])';
    source = ok(addComponent(source, { parent: 'root' }, 'NumberInput')).source;
    source = ok(addComponent(source, { parent: 'root' }, 'NumberInput')).source;
    expect(source).toContain('$numberInput = 0');
    expect(source).toContain('$numberInput2 = 0');
    expect(source).toContain('"Label 2"');
    expect(errors(source)).toEqual([]);
  });

  it('adds a form with its own submit button, and refuses a parent that cannot hold children', () => {
    const form = ok(addComponent('root = Stack([])', { parent: 'root' }, 'Form')).source;
    expect(form).toContain('submit = Button("Submit", @Reset())');
    expect(flat(outline(form))).toEqual(['root', 'form', 'submit']);
    expect(addComponent(PROGRAM, { parent: 'title' }, 'Text')).toHaveProperty('error');
    expect(addComponent(PROGRAM, { parent: 'root' }, 'Nope')).toHaveProperty('error');
  });

  it('refuses to arrange children that a program computes', () => {
    const computed =
      'root = Stack(@Each(rows.items, "i", Text(i.title)))\nrows = Query("list_items", {}, {items: []})';
    expect(addComponent(computed, { parent: 'root' }, 'Text')).toHaveProperty('error');
  });
});

describe('moveComponent', () => {
  it('reorders within a container', () => {
    const { source } = ok(moveComponent(PROGRAM, 'add', { parent: 'root', index: 0 }));
    expect(flat(outline(source))).toEqual(['root', 'add', 'title', 'card', 'stat', 'Text']);
    expect(without(source, ['root'])).toEqual(without(PROGRAM, ['root']));
  });

  it('moves between containers, inline children included in the target', () => {
    const { source } = ok(moveComponent(PROGRAM, 'title', { parent: 'card', index: 1 }));
    expect(flat(outline(source))).toEqual(['root', 'card', 'stat', 'title', 'Text', 'add']);
    expect(errors(source)).toEqual([]);
    expect(without(source, ['root', 'card'])).toEqual(without(PROGRAM, ['root', 'card']));
  });

  it('refuses the root, a move into itself or its own descendant, and a non-container', () => {
    expect(moveComponent(PROGRAM, 'root', { parent: 'card', index: 0 })).toHaveProperty('error');
    expect(moveComponent(PROGRAM, 'card', { parent: 'card', index: 0 })).toHaveProperty('error');
    const nested = ok(addComponent(PROGRAM, { parent: 'card' }, 'Row')).source;
    expect(moveComponent(nested, 'card', { parent: 'row', index: 0 })).toHaveProperty('error');
    expect(moveComponent(PROGRAM, 'add', { parent: 'title', index: 0 })).toHaveProperty('error');
  });
});

describe('deleteComponent', () => {
  it('removes the reference and the statement when nothing else refers to it', () => {
    const { source } = ok(deleteComponent(PROGRAM, 'title'));
    expect(source).not.toContain('title');
    expect(flat(outline(source))).toEqual(['root', 'card', 'stat', 'Text', 'add']);
    expect(without(source, ['root'])).toEqual(without(PROGRAM, ['root', 'title']));
  });

  it('removes a container with the children only it held', () => {
    const { source } = ok(deleteComponent(PROGRAM, 'card'));
    expect(source).not.toContain('stat');
    expect(source).not.toContain('card');
    expect(errors(source)).toEqual([]);
  });

  it('keeps a statement something else still names', () => {
    const shared = PROGRAM.replace(
      'root = Stack([title, card, add])',
      'root = Stack([title, card, add, title])',
    );
    const { source } = ok(deleteComponent(shared, 'title'));
    expect(source).toContain('title = Text("Hello",   "title")');
    expect(flat(outline(source))).toContain('title');
  });

  it('refuses the root and a form’s submit button', () => {
    expect(deleteComponent(PROGRAM, 'root')).toEqual({ error: 'The root cannot be deleted.' });
    const form = ok(addComponent('root = Stack([])', { parent: 'root' }, 'Form')).source;
    expect(deleteComponent(form, 'submit')).toHaveProperty('error');
    expect(moveComponent(form, 'submit', { parent: 'root', index: 0 })).toHaveProperty('error');
  });

  it('can delete the last statement of a file with no trailing newline', () => {
    const { source } = ok(deleteComponent('root = Stack([a])\na = Text("x")', 'a'));
    expect(source).toBe('root = Stack([])');
  });
});

describe('liftInline', () => {
  it('gives an inline component a statement of its own and a reference in its place', () => {
    const inline = outline(PROGRAM)?.children[1]?.children[1];
    expect(inline?.kind).toBe('inline');
    const { source, id } = ok(
      liftInline(PROGRAM, inline?.at ?? { parent: '', prop: '', index: 0 }),
    );
    expect(id).toBe('text');
    expect(source).toContain('text = Text("inline", "note")');
    expect(flat(outline(source))).toEqual(['root', 'title', 'card', 'stat', 'text', 'add']);
    expect(errors(source)).toEqual([]);
    expect(without(source, ['card', 'text'])).toEqual(without(PROGRAM, ['card']));
    expect(liftInline(PROGRAM, { parent: 'root', prop: 'children', index: 0 })).toHaveProperty(
      'error',
    );
  });
});

describe('the collection helper', () => {
  it('adds a query under a free name that the library reads', () => {
    const { source, id } = ok(addItemsQuery('root = Stack([])'));
    expect(id).toBe('items');
    expect(source).toBe(
      'root = Stack([])\nitems = Query("list_items", {parentId: $container}, {items: []})',
    );
    const again = ok(addItemsQuery(source));
    expect(again.id).toBe('items2');
    expect(without(again.source, ['items2'])).toEqual(without(source, []));
  });

  it('binds a table, a list and a chart to the items, reusing the query', () => {
    let source = 'root = Stack([])';
    for (const type of ['Table', 'ItemList', 'Chart'])
      source = ok(addComponent(source, { parent: 'root' }, type)).source;
    for (const id of ['table', 'itemList', 'chart']) source = ok(bindItems(source, id)).source;
    expect(source.match(/Query\(/g)).toHaveLength(1);
    expect(source).toContain('@Each(items.items, "item", [item.title, item.type])');
    expect(source).toContain('itemList = ItemList(items.items)');
    expect(errors(source.replaceAll('$container', '"c"'))).toEqual([]);
    expect(bindItems(source, 'root')).toHaveProperty('error');
  });
});

describe('setStatement', () => {
  it('edits a query or a state value and refuses a broken one', () => {
    const { source } = ok(setStatement(PROGRAM, '$n', '5'));
    expect(source).toContain('$n = 5');
    expect(without(source, ['$n'])).toEqual(without(PROGRAM, ['$n']));
    expect(setStatement(PROGRAM, '$n', '5 5')).toHaveProperty('error');
    expect(setStatement(PROGRAM, 'gone', '5')).toHaveProperty('error');
  });
});

describe('the contracts as props', () => {
  it('follow the library’s positional order', () => {
    expect(propsOf('Card').map((prop) => [prop.name, prop.kind])).toEqual([
      ['title', 'string'],
      ['children', 'children'],
    ]);
    expect(propsOf('Text')[0]?.kind).toBe('string');
    expect(propsOf('NumberInput').find((prop) => prop.name === 'value')?.reactive).toBe(true);
    expect(propsOf('Chart')[0]?.options).toEqual(['column', 'line', 'pie']);
    expect(propsOf('Query')).toEqual([]);
  });
});
