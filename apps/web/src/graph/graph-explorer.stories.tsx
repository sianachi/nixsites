import type { GraphLink, GraphNode } from '@nix/api-client';
import type { ReactElement } from 'react';
import { fireEvent, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { GraphExplorer } from './graph-explorer';
import { GraphView } from './graph-view';
import type { GraphRepresentation } from './graph-representations';

export default { title: 'Nix/Graph', parameters: { layout: 'padded' } };
const noop = (): void => undefined;
const nodes: GraphNode[] = [
  ['project', 'Launch project', null, 1],
  ['research', 'Research', 'project', 3],
  ['interviews', 'Customer interviews', 'research', 5],
  ['findings', 'Research findings', 'research', 9],
  ['design', 'Design', 'project', 12],
  ['prototype', 'Prototype', 'design', 14],
  ['feedback', 'Prototype feedback', 'design', 17],
  ['launch', 'Launch checklist', 'project', 21],
  ['ideas', 'Future ideas', null, 25],
].map(([id, title, parentId, day]) => ({
  id: String(id),
  title: String(title),
  parentId: parentId === null ? null : String(parentId),
  type: 'note',
  createdAt: new Date(Date.UTC(2026, 0, Number(day))).toISOString(),
  lastModifiedAt: null,
}));
const links: GraphLink[] = [
  { sourceId: 'research', targetId: 'interviews', occurrences: 3 },
  { sourceId: 'interviews', targetId: 'findings', occurrences: 3 },
  { sourceId: 'findings', targetId: 'research', occurrences: 3 },
  { sourceId: 'design', targetId: 'prototype', occurrences: 3 },
  { sourceId: 'prototype', targetId: 'feedback', occurrences: 3 },
  { sourceId: 'feedback', targetId: 'design', occurrences: 3 },
  { sourceId: 'findings', targetId: 'prototype', occurrences: 1 },
  { sourceId: 'launch', targetId: 'feedback', occurrences: 1 },
];
function view(representation: GraphRepresentation): ReactElement {
  return (
    <GraphView
      nodes={nodes}
      links={links}
      representation={representation}
      focusId="prototype"
      distance={1}
      onOpen={noop}
    />
  );
}
export function Focused(): ReactElement {
  return view('focused');
}
export function Hierarchy(): ReactElement {
  return view('hierarchy');
}
export function Clusters(): ReactElement {
  return view('clusters');
}
export function Chronological(): ReactElement {
  return view('chronological');
}
export function LayoutPicker(): ReactElement {
  return <GraphExplorer nodes={nodes} links={links} onOpen={noop} />;
}
export function SearchAndFocus(): ReactElement {
  return (
    <GraphExplorer nodes={nodes} links={links} initialFocusId="prototype" onOpen={noop} partial />
  );
}
SearchAndFocus.play = async ({
  canvasElement,
}: {
  readonly canvasElement: HTMLElement;
}): Promise<void> => {
  const canvas = within(canvasElement);
  await userEvent.type(
    canvas.getByRole('searchbox', { name: 'Find an item' }),
    'Research findings',
  );
  await userEvent.click(canvas.getByRole('button', { name: 'Show Research findings in graph' }));
  await canvas.findByText('Showing Research findings');
};
export function DarkClusters(): ReactElement {
  return view('clusters');
}
DarkClusters.globals = { ground: 'dark' };
export function PhoneChronological(): ReactElement {
  return <div className="max-w-sm">{view('chronological')}</div>;
}
export function PartialFocused(): ReactElement {
  return (
    <GraphView
      nodes={nodes}
      links={links}
      representation="focused"
      focusId="prototype"
      partial
      onOpen={noop}
    />
  );
}
export function Empty(): ReactElement {
  return <GraphExplorer nodes={[]} links={[]} onOpen={noop} />;
}

export function DrawnNodeActions(): ReactElement {
  return view('hierarchy');
}
DrawnNodeActions.play = async ({
  canvasElement,
}: {
  readonly canvasElement: HTMLElement;
}): Promise<void> => {
  const node = canvasElement.querySelector('[data-graph-node="project"]');
  if (node === null) throw new Error('The graph node is missing.');
  fireEvent.contextMenu(node);
  await within(document.body).findByRole('menuitem', { name: 'Fold branch' });
};

export function BrowseItemActions(): ReactElement {
  return <GraphExplorer nodes={nodes} links={links} onOpen={noop} />;
}
BrowseItemActions.play = async ({
  canvasElement,
}: {
  readonly canvasElement: HTMLElement;
}): Promise<void> => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Browse connections' }));
  await userEvent.type(canvas.getByRole('searchbox', { name: 'Find an item' }), 'Launch project');
  fireEvent.contextMenu(canvas.getByRole('button', { name: 'Launch project' }));
  await within(document.body).findByRole('menu', { name: 'Launch project actions' });
};

export function TinyBrowse(): ReactElement {
  const longTitle = 'VeryLongItemTitleWithoutSpaces'.repeat(5);
  return (
    <div className="w-64 max-w-full">
      <GraphExplorer
        nodes={nodes.slice(0, 1).map((node) => ({ ...node, id: 'long-title', title: longTitle }))}
        links={[]}
        onOpen={noop}
      />
    </div>
  );
}
TinyBrowse.play = async ({
  canvasElement,
}: {
  readonly canvasElement: HTMLElement;
}): Promise<void> => {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Browse connections' }));
};

export function TinyFocused(): ReactElement {
  return (
    <div className="w-64 max-w-full">
      <GraphExplorer
        nodes={nodes.map((node) => ({
          ...node,
          title: 'VeryLongItemTitleWithoutSpaces'.repeat(5),
        }))}
        links={links}
        initialFocusId="prototype"
        onOpen={noop}
      />
    </div>
  );
}
