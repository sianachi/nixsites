import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => null,
  useOptionalApiClient: () => null,
}));

const { default: ProgramDesigner } = await import('../../openui/program-designer');
const { ProgramEditor } = await import('../../openui/program-editor');

const workspace = '11111111-1111-4111-8111-111111111111';

const PROGRAM = [
  'root = Stack([title, card, add])',
  'title = Text("Hello", "title")',
  '$n = 0',
  'card = Card("Stats", [count, Text("inline", "note")])',
  'count = Stat("Count", $n)',
  'add = Button("Add", @Set($n, $n + 1))',
].join('\n');

function Harness({
  initial,
  containerId,
}: {
  readonly initial: string;
  readonly containerId?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MemoryRouter>
      <ProgramDesigner
        value={value}
        onChange={setValue}
        workspaceId={workspace}
        containerId={containerId}
      />
      <pre data-testid="source">{value}</pre>
    </MemoryRouter>
  );
}

const source = () => screen.getByTestId('source').textContent;
const row = (name: RegExp) => screen.getByRole('treeitem', { name });

describe('the designer', () => {
  it('selects from the outline and shows the component’s props in the inspector', async () => {
    render(<Harness initial={PROGRAM} />);
    const tree = await screen.findByRole('tree', { name: 'Component outline' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(6);
    fireEvent.click(within(tree).getByText('title'));
    const inspector = screen.getByRole('region', { name: 'Inspector' });
    expect(within(inspector).getByRole('heading', { name: /Text/ })).toBeInTheDocument();
    expect(within(inspector).getByLabelText(/value/)).toHaveValue('Hello');
    expect(within(inspector).getByLabelText(/variant/)).toHaveValue('title');
  });

  it('selects from the canvas, and a click on a button there does not run it', async () => {
    render(<Harness initial={PROGRAM} />);
    const canvas = await screen.findByRole('region', { name: 'Canvas' });
    const button = await within(canvas).findByRole('button', { name: 'Add' });
    fireEvent.click(button);
    fireEvent.click(button);
    // The Stat still reads 0: the Set never ran, and the click selected the frame instead.
    expect(within(canvas).getByRole('group', { name: 'Stat count' })).toHaveTextContent('0');
    expect(within(canvas).getByRole('group', { name: 'Button add' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(
      within(screen.getByRole('region', { name: 'Inspector' })).getByRole('heading', {
        name: /Button/,
      }),
    ).toBeInTheDocument();
  });

  it('edits a literal prop in the inspector and writes it into the program', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('title'));
    const field = screen.getByLabelText(/value/);
    fireEvent.change(field, { target: { value: 'Goodbye' } });
    fireEvent.blur(field);
    expect(source()).toContain('title = Text("Goodbye", "title")');
    expect(source()).toContain('add = Button("Add", @Set($n, $n + 1))');
  });

  it('shows an expression prop as code, checks it, and refuses a broken one inline', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('count'));
    const field = screen.getByLabelText(/value/);
    expect(field).toHaveValue('$n');
    fireEvent.change(field, { target: { value: '$n +' } });
    fireEvent.blur(field);
    expect(screen.getByText('The expression is not finished.')).toBeInTheDocument();
    expect(source()).toContain('count = Stat("Count", $n)');
    fireEvent.change(field, { target: { value: '$n + 1' } });
    fireEvent.blur(field);
    expect(source()).toContain('count = Stat("Count", $n + 1)');
  });

  it('turns a literal prop into an expression field on request', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('title'));
    const inspector = screen.getByRole('region', { name: 'Inspector' });
    const [toggle] = within(inspector).getAllByRole('button', { name: 'Use an expression' });
    fireEvent.click(toggle ?? inspector);
    expect(within(inspector).getByLabelText(/value/)).toHaveValue('"Hello"');
  });

  it('inserts from the palette into the selected container, or after the selected component', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('card'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Row' }));
    expect(source()).toContain('card = Card("Stats", [count, Text("inline", "note"), row])');
    expect(source()).toContain('row = Row([])');
    // the new component is selected, and a leaf takes the next one in after itself
    fireEvent.click(screen.getByText('count'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Toggle' }));
    expect(source()).toContain(
      'card = Card("Stats", [count, toggle, Text("inline", "note"), row])',
    );
  });

  it('moves and deletes the selection from buttons, and undoes and redoes them', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('add'));
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(source()).toContain('root = Stack([title, add, card])');
    fireEvent.click(screen.getByRole('button', { name: 'Move down' }));
    expect(source()).toContain('root = Stack([title, card, add])');
    expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(source()).not.toContain('add');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(source()).toBe(PROGRAM);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(source()).not.toContain('add');
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'z', ctrlKey: true });
    expect(source()).toBe(PROGRAM);
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'z', ctrlKey: true, shiftKey: true });
    expect(source()).not.toContain('add');
  });

  it('will not delete the root', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByRole('treeitem', { name: /root/ }));
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('lifts an inline component when it is selected in the outline', async () => {
    render(<Harness initial={PROGRAM} />);
    fireEvent.click(await screen.findByText('(inline)'));
    expect(source()).toContain('text = Text("inline", "note")');
    expect(source()).toContain('card = Card("Stats", [count, text])');
    expect(screen.getByRole('treeitem', { name: /text/, selected: true })).toBeInTheDocument();
  });

  it('moves with the keyboard: arrows travel the tree and Enter selects', async () => {
    render(<Harness initial={PROGRAM} />);
    const root = await screen.findByRole('treeitem', { name: /root/ });
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    const title = row(/title/);
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(title).toHaveAttribute('aria-selected', 'true');
  });

  it('adds and moves by dragging', async () => {
    render(<Harness initial={PROGRAM} />);
    const dataTransfer = { setData: vi.fn() };
    const palette = await screen.findByRole('button', { name: 'Add Chart' });
    fireEvent.dragStart(palette, { dataTransfer });
    const tree = screen.getByRole('tree');
    fireEvent.drop(within(tree).getByText('card'), { dataTransfer });
    expect(source()).toContain('Card("Stats", [count, Text("inline", "note"), chart])');
    fireEvent.dragStart(within(tree).getByText('title'), { dataTransfer });
    fireEvent.drop(within(tree).getByText('add'), { dataTransfer });
    expect(source()).toContain('root = Stack([card, title, add])');
  });

  it('lists data statements as code and adds the collection helper in a view', async () => {
    render(<Harness initial={PROGRAM} containerId={workspace} />);
    const data = await screen.findByRole('group', { name: 'Program data' });
    expect(within(data).getByLabelText('$n (state)')).toHaveValue('0');
    fireEvent.click(within(data).getByRole('button', { name: /items in this collection/ }));
    expect(source()).toContain('items = Query("list_items", {parentId: $container}, {items: []})');
  });

  it('offers to show a table’s rows from the collection', async () => {
    render(
      <Harness
        initial={'root = Stack([table])\ntable = Table([], [], "Items")'}
        containerId={workspace}
      />,
    );
    fireEvent.click(await screen.findByText('table'));
    fireEvent.click(screen.getByRole('button', { name: 'Show items in this collection' }));
    expect(source()).toContain('items = Query("list_items"');
    expect(source()).toContain('@Each(items.items, "item", [item.title, item.type])');
  });

  it('starts an empty program with an empty layout', async () => {
    render(<Harness initial="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start with an empty layout' }));
    expect(source()).toBe('root = Stack([])');
  });
});

describe('the program editor’s mode', () => {
  it('opens in Design when the program has a root, and Code carries the same text', async () => {
    render(
      <MemoryRouter>
        <ProgramEditor value={PROGRAM} onChange={vi.fn()} workspaceId={workspace} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('tree', { name: 'Component outline' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Code' }));
    expect(screen.getByLabelText('Program')).toHaveValue(PROGRAM);
  });

  it('opens in Code, with a note, when the program cannot be designed', () => {
    render(
      <MemoryRouter>
        <ProgramEditor value="oops" onChange={vi.fn()} workspaceId={workspace} />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Program')).toHaveValue('oops');
    expect(screen.getByText(/Design needs a program that parses/)).toBeInTheDocument();
  });
});
