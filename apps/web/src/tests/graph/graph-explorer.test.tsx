import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GraphExplorer, graphConnections } from '../../graph/graph-explorer';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { GraphView } from '../../graph/graph-view';
import { readGraphPresentation, writeGraphPresentation } from '../../graph/graph-presentation';
import { readArrangement, writeArrangement } from '../../graph/graph-arrangement';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalScroll === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  else Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll);
});
const DATES = {
  createdAt: '2026-01-01T00:00:00+00:00',
  lastModifiedAt: '2026-01-01T00:00:00+00:00',
};

const nodes = [
  { id: 'project', title: 'Project', parentId: null, type: 'note', ...DATES },
  { id: 'plan', title: 'Plan', parentId: 'project', type: 'note', ...DATES },
];
it('indexes both directions of structural and reference connections', () => {
  const connections = graphConnections(nodes, [
    { sourceId: 'plan', targetId: 'project', occurrences: 1 },
  ]);
  expect(connections.get('plan')).toEqual([
    { id: 'project', relation: 'Inside' },
    { id: 'project', relation: 'Links to' },
  ]);
  expect(connections.get('project')).toEqual([
    { id: 'plan', relation: 'Contains' },
    { id: 'plan', relation: 'Linked from' },
  ]);
});

it('switches every representation and supplies focus controls, scope and equivalent keyboard information', async () => {
  stubViewport(true);
  const user = userEvent.setup();
  const graphNodes = [
    ...nodes,
    { id: 'unrelated', title: 'Unrelated', parentId: null, type: 'note', ...DATES },
  ];
  render(
    <GraphExplorer workspaceId="layouts" nodes={graphNodes} links={[]} onOpen={vi.fn()} partial />,
  );
  const picker = screen.getByRole('combobox', { name: 'Graph layout' });
  await user.selectOptions(picker, 'focused');
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('combobox', { name: 'Connection distance' })).toHaveValue('1');
  expect(
    screen.getByText(/2 of 3 loaded items within 1 connection step of Plan/),
  ).toHaveTextContent('loaded portion');
  const tree = screen.getByRole('tree');
  expect(within(tree).getByRole('button', { name: /Plan.*Focus item/ })).toBeInTheDocument();
  expect(within(tree).queryByRole('button', { name: /Unrelated/ })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Focus item' }), 'unrelated');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  expect(readGraphPresentation('layouts').focusId).toBe('unrelated');
  await user.selectOptions(picker, 'hierarchy');
  expect(screen.getByText(/Parents above children/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Fold all' }));
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2);
  await user.selectOptions(picker, 'clusters');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(3);
  expect(
    within(screen.getByRole('tree')).getByRole('button', { name: /Plan.*Connection group/ }),
  ).toBeInTheDocument();
  await user.selectOptions(picker, 'chronological');
  expect(
    within(screen.getByRole('tree')).getByRole('button', { name: /Plan.*Created/ }),
  ).toBeInTheDocument();
  await user.selectOptions(picker, 'radial');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(3);
});

it('restores workspace preferences, recovers from a removed focus item and resets on workspace changes', () => {
  stubViewport(true);
  writeGraphPresentation('first', { representation: 'focused', focusId: 'deleted', distance: 2 });
  writeGraphPresentation('second', { representation: 'chronological', focusId: null, distance: 1 });
  const props = { nodes, links: [], onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} workspaceId="first" />);
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('combobox', { name: 'Connection distance' })).toHaveValue('2');
  rerender(<GraphExplorer {...props} workspaceId="second" />);
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('chronological');
});

it('opens focus mode from the phone list', async () => {
  stubViewport(false);
  const user = userEvent.setup();
  render(<GraphExplorer nodes={nodes} links={[]} onOpen={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Focus graph on Plan' }));
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('focused');
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
});

it('searches all loaded titles above the drawing and focuses a result outside the current neighborhood', async () => {
  stubViewport(true);
  const user = userEvent.setup();
  const unrelated = {
    id: 'unrelated',
    title: 'Weekly training',
    parentId: null,
    type: 'note',
    ...DATES,
  };
  const { container } = render(
    <GraphExplorer
      nodes={[...nodes, unrelated]}
      links={[]}
      initialFocusId="plan"
      onOpen={vi.fn()}
      partial
    />,
  );
  const search = screen.getByRole('searchbox', { name: 'Find an item' });
  const drawing = container.querySelector('svg[class~="group/graph"]');
  if (drawing === null) throw new Error('The graph drawing is missing.');
  expect(search.compareDocumentPosition(drawing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(
    within(screen.getByRole('tree')).queryByRole('button', { name: /Weekly training/ }),
  ).not.toBeInTheDocument();

  await user.type(search, ' training ');
  expect(
    within(screen.getByRole('region', { name: 'Graph search results' })).getByRole('status'),
  ).toHaveTextContent('1 matching items in the loaded portion');
  await user.click(screen.getByRole('button', { name: 'Focus graph on Weekly training' }));

  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('unrelated');
  expect(screen.getByRole('combobox', { name: 'Connection distance' })).toHaveValue('1');
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  expect(screen.getByText('Showing Weekly training')).toBeInTheDocument();
  expect(search).toHaveValue('');
  expect(screen.getByRole('region', { name: 'Spatial graph' })).toHaveFocus();
});

it('opens a requested focused graph on a phone and resets the destination when its focus changes', () => {
  stubViewport(false);
  const props = { nodes, links: [], onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} initialFocusId="plan" />);
  expect(screen.getByRole('button', { name: 'Spatial graph' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  rerender(<GraphExplorer {...props} initialFocusId="project" />);
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('project');
});

it('explains an unavailable requested focus without implying the graph covers the whole workspace', () => {
  stubViewport(false);
  render(
    <GraphExplorer nodes={nodes} links={[]} initialFocusId="outside" onOpen={vi.fn()} partial />,
  );
  expect(screen.getByText(/This item is not in the visible graph/)).toHaveTextContent(
    'outside the loaded portion',
  );
  expect(screen.getByText('2 matching items in the loaded portion')).toBeInTheDocument();
  expect(screen.queryByRole('combobox', { name: 'Focus item' })).not.toBeInTheDocument();
});

it('applies a pending focus once the requested item becomes visible', () => {
  stubViewport(false);
  const props = { links: [], initialFocusId: 'plan', onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} nodes={nodes.slice(0, 1)} />);
  expect(screen.getByText(/This item is not in the visible graph/)).toBeInTheDocument();
  rerender(<GraphExplorer {...props} nodes={nodes} />);
  expect(screen.queryByText(/This item is not in the visible graph/)).not.toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('region', { name: 'Spatial graph' })).toHaveFocus();
});

it('lets a reader replace an unavailable focus before that item appears', async () => {
  stubViewport(false);
  const props = { links: [], initialFocusId: 'plan', onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} nodes={nodes.slice(0, 1)} />);
  await userEvent.click(screen.getByRole('button', { name: 'Focus graph on Project' }));
  expect(screen.queryByText(/This item is not in the visible graph/)).not.toBeInTheDocument();
  rerender(<GraphExplorer {...props} nodes={nodes} />);
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('project');
});

it('keeps the item the reader showed in the graph when the pending note later appears', async () => {
  stubViewport(false);
  const props = { links: [], initialFocusId: 'plan', onOpen: vi.fn() };
  const { rerender } = render(<GraphExplorer {...props} nodes={nodes.slice(0, 1)} />);
  await userEvent.click(screen.getByRole('button', { name: 'Show Project in graph' }));
  rerender(<GraphExplorer {...props} nodes={nodes} />);
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('radial');
  expect(screen.getByText('Showing Project')).toBeInTheDocument();
});

it('offers item actions on long press without also opening the item', () => {
  stubViewport(false);
  vi.useFakeTimers();
  const onOpen = vi.fn();
  render(<GraphExplorer nodes={nodes} links={[]} onOpen={onOpen} />);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find an item' }), {
    target: { value: 'Plan' },
  });
  const item = screen.getByRole('button', { name: 'Plan' });
  fireEvent.pointerDown(item, {
    pointerType: 'touch',
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  fireEvent.pointerUp(item, { pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0 });
  fireEvent.click(item);
  const menu = screen.getByRole('menu', { name: 'Plan actions' });
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Focus in graph' }));
  expect(screen.getByRole('combobox', { name: 'Focus item' })).toHaveValue('plan');
  expect(screen.getByRole('combobox', { name: 'Graph layout' })).toHaveValue('focused');
});

it('keeps timeline positions fixed during a drag and still opens an item on a click', () => {
  stubViewport(true);
  const onOpen = vi.fn();
  const onMove = vi.fn();
  const { container } = render(
    <GraphView
      nodes={nodes}
      links={[]}
      representation="chronological"
      onOpen={onOpen}
      onMove={onMove}
    />,
  );
  const disc = container.querySelector('svg > g.group');
  expect(disc).not.toBeNull();
  if (!disc) return;
  const startX = disc.querySelector('circle')?.getAttribute('cx');
  fireEvent.pointerDown(disc, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(disc, { pointerId: 1, clientX: 200, clientY: 180 });
  fireEvent.pointerUp(disc, { pointerId: 1, clientX: 200, clientY: 180 });
  expect(disc.querySelector('circle')?.getAttribute('cx')).toBe(startX);
  expect(screen.queryByRole('button', { name: 'Tidy up' })).not.toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
  expect(onMove).not.toHaveBeenCalled();
  fireEvent.pointerDown(disc, { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
  fireEvent.pointerUp(disc, { pointerId: 2, clientX: 100, clientY: 100 });
  expect(onOpen).toHaveBeenCalledWith('project');
});

it('selects a touched node first even when the device also has a mouse', () => {
  stubViewport(true);
  const onOpen = vi.fn();
  const { container } = render(<GraphView nodes={nodes} links={[]} onOpen={onOpen} />);
  const disc = container.querySelector('svg > g.group');
  if (disc === null) throw new Error('The graph node is missing.');
  const touch = { button: 0, pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 };
  fireEvent.pointerDown(disc, touch);
  fireEvent.pointerUp(disc, touch);
  expect(onOpen).not.toHaveBeenCalled();
  expect(disc.querySelector('button')).toHaveTextContent('Open Project');
  fireEvent.pointerDown(disc, touch);
  fireEvent.pointerUp(disc, touch);
  expect(onOpen).toHaveBeenCalledWith('project');
});

it('offers drawn node actions without opening or nudging a held node', () => {
  stubViewport(true);
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const { container } = render(<GraphView nodes={nodes} links={[]} onOpen={onOpen} />);
  const disc = container.querySelector('[data-graph-node="project"]');
  if (disc === null) throw new Error('The graph node is missing.');
  const touch = {
    button: 0,
    pointerId: 1,
    isPrimary: true,
    pointerType: 'touch',
    clientX: 100,
    clientY: 100,
  };
  fireEvent.pointerDown(disc, touch);
  fireEvent.pointerMove(disc, { ...touch, clientX: 106 });
  act(() => {
    vi.advanceTimersByTime(500);
  });
  fireEvent.pointerUp(disc, touch);
  fireEvent.click(disc);
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Tidy up' })).not.toBeInTheDocument();
  const menu = screen.getByRole('menu', { name: 'Graph item actions' });
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Fold branch' }));
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  const foldedNode = container.querySelector('[data-graph-node="project"]');
  if (foldedNode === null) throw new Error('The folded graph node is missing.');
  fireEvent.pointerDown(foldedNode, { button: 2, pointerId: 2, pointerType: 'mouse' });
  fireEvent.contextMenu(foldedNode);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open Project' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('project');
});

it('reads separate saved arrangements for each layout and keeps the legacy radial entry', () => {
  const ids = new Set(nodes.map((node) => node.id));
  writeArrangement('workspace', {
    offsets: new Map(),
    collapsed: new Set(['project']),
    view: null,
  });
  writeArrangement('workspace:hierarchy', { offsets: new Map(), collapsed: new Set(), view: null });
  const props = { nodes, links: [], onOpen: vi.fn(), workspaceId: 'workspace' };
  const { rerender } = render(<GraphView {...props} representation="radial" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  rerender(<GraphView {...props} representation="hierarchy" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(2);
  fireEvent.keyDown(within(screen.getByRole('tree')).getByRole('button', { name: /Project,/ }), {
    key: 'ArrowLeft',
  });
  rerender(<GraphView {...props} representation="radial" />);
  rerender(<GraphView {...props} representation="hierarchy" />);
  expect(within(screen.getByRole('tree')).getAllByRole('treeitem')).toHaveLength(1);
  expect([...readArrangement('workspace', ids).collapsed]).toEqual(['project']);
});
it('defaults to searchable browsing on phones and opens items through the supplied dialog action', async () => {
  stubViewport(false);
  const onOpen = vi.fn();
  const user = userEvent.setup();
  render(<GraphExplorer nodes={nodes} links={[]} onOpen={onOpen} />);
  expect(screen.getByRole('button', { name: 'Browse connections' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
  await user.type(screen.getByRole('searchbox', { name: 'Find an item' }), 'Plan');
  await user.click(screen.getByRole('button', { name: 'Plan' }));
  expect(onOpen).toHaveBeenCalledWith('plan');
});

it('brings the spatial graph into view after choosing an item from the phone list', async () => {
  stubViewport(false);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  });

  try {
    const user = userEvent.setup();
    render(<GraphExplorer nodes={nodes} links={[]} onOpen={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Show Plan in graph' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    } else {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
    }
  }
});

it('reveals only the hovered node label, then hides it when the pointer leaves', () => {
  const { container } = render(
    <GraphView workspaceId="hover-labels" nodes={nodes} links={[]} onOpen={vi.fn()} />,
  );
  const project = container.querySelector('[data-graph-node="project"]');
  const plan = container.querySelector('[data-graph-node="plan"]');
  if (!project || !plan) throw new Error('Graph nodes were not rendered');
  expect(project.querySelector('text')).toHaveClass('opacity-0');
  expect(plan.querySelector('text')).toHaveClass('opacity-0');
  fireEvent.pointerEnter(project);
  expect(project.querySelector('text')).not.toHaveClass('opacity-0');
  expect(plan.querySelector('text')).toHaveClass('opacity-0');
  fireEvent.pointerLeave(project);
  expect(project.querySelector('text')).toHaveClass('opacity-0');
});
