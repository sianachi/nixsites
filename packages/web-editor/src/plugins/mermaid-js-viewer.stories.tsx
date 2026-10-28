import type { ReactElement } from 'react';
import { waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';

import { MermaidViewer } from './mermaid-js-viewer';

export default { title: 'Nix/Files/Mermaid', parameters: { layout: 'fullscreen' } };

const ARCHITECTURE = `flowchart LR
  Browser[Web browser] -->|HTTPS BFF|Core[Core API]
  CLI[nixctl and MCP] -->|Nix API|Core
  Browser -->|CRDT updates|Collab[Collaboration service]
  Collab -->|Authorize items|Core
  Core -->|Durable items and permissions|Postgres[(Postgres)]
  Collab -->|Append updates|Postgres
  Core -->|Background jobs|RabbitMQ[(RabbitMQ)]
  RabbitMQ --> Workers[Go workers]
  Core -->|Capability URL|Files[(Object storage)]
  Browser -->|File bytes|Files
`;

export const Architecture = {
  render: (): ReactElement => (
    <div className="p-6">
      <MermaidViewer fileName="nix-architecture.mmd" source={ARCHITECTURE} />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole(
      'img',
      { name: 'nix-architecture.mmd diagram' },
      { timeout: 10_000 },
    );
  },
};

export const ArchitectureDark = {
  ...Architecture,
  globals: { ground: 'dark' },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await Architecture.play({ canvasElement });
    const diagram = within(canvasElement).getByRole('img');
    const lines = diagram.querySelectorAll('.flowchart-link, marker path');
    if (lines.length === 0) throw new Error('The diagram did not contain connectors.');
    for (const line of lines) {
      const style = getComputedStyle(line);
      if (style.stroke === 'rgb(0, 0, 0)' || style.fill === 'rgb(0, 0, 0)')
        throw new Error('A dark-mode connector or arrowhead was black.');
    }
  },
};

export const JourneyDark = {
  globals: { ground: 'dark' },
  render: (): ReactElement => (
    <div className="p-2 sm:p-6">
      <MermaidViewer
        fileName="writing-journey.mmd"
        source={`journey
          title A writing day
          section Draft
            Write: 5: Writer
            Review: 4: Writer
        `}
      />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    const diagram = await within(canvasElement).findByRole('img', {
      name: 'writing-journey.mmd diagram',
    });
    const lines = diagram.querySelectorAll('svg line');
    if (lines.length === 0) throw new Error('The journey did not contain lines.');
    for (const line of lines) {
      if (getComputedStyle(line).stroke === 'rgb(0, 0, 0)')
        throw new Error('A dark-mode journey line was black.');
    }
  },
};

export const VerySmallScreen = {
  ...Architecture,
  render: (): ReactElement => (
    <div className="w-64 max-w-full p-2">
      <MermaidViewer fileName="nix-architecture.mmd" source={ARCHITECTURE} />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await Architecture.play({ canvasElement });
    const region = within(canvasElement).getByRole('region', { name: 'Scrollable diagram' });
    if (region.scrollWidth > region.clientWidth)
      throw new Error('The fitted diagram overflowed its narrow container.');
  },
};

export const ZoomedArchitecture = {
  ...Architecture,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await Architecture.play({ canvasElement });
    const canvas = within(canvasElement);
    const svg = canvas.getByRole('img').querySelector('svg');
    if (svg === null) throw new Error('The diagram did not contain an SVG.');
    const width = svg.getBoundingClientRect().width;
    await userEvent.click(canvas.getByRole('button', { name: 'Zoom in' }));
    await waitFor(() => {
      if (svg.getBoundingClientRect().width <= width)
        throw new Error('The diagram did not grow when zoomed.');
    });
  },
};

export const ExpandedArchitecture = {
  ...Architecture,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await Architecture.play({ canvasElement });
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Expand diagram' }));
    await within(canvasElement).findByRole('dialog', { name: 'nix-architecture.mmd' });
  },
};

export const Sequence = {
  render: (): ReactElement => (
    <div className="p-6">
      <MermaidViewer
        fileName="nix-collaboration.mmd"
        source={`sequenceDiagram
        participant Browser
        participant Collaboration
        participant Core
        participant Postgres
        Browser->>Collaboration: Open item document
        Collaboration->>Core: Authorize item
        Core-->>Collaboration: Access decision
        Collaboration->>Postgres: Read updates
        Collaboration-->>Browser: Synchronize document
      `}
      />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole(
      'img',
      { name: 'nix-collaboration.mmd diagram' },
      { timeout: 10_000 },
    );
  },
};

export const SyntaxError = {
  render: (): ReactElement => (
    <div className="p-6">
      <MermaidViewer fileName="draft.mmd" source="flowchart LR\nCore -->" />
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('alert', {}, { timeout: 10_000 });
  },
};
