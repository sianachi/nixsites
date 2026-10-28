import type { ReactElement } from 'react';
import { within } from '@testing-library/dom';

import { CsvViewer } from './csv-viewer';
import { MarkdownViewer } from './markdown-viewer';
import { TextViewer } from './text-viewer';

export default { title: 'Nix/Files/Viewers', parameters: { layout: 'fullscreen' } };

function Stage({ children }: { readonly children: ReactElement }): ReactElement {
  return <div className="flex h-screen flex-col">{children}</div>;
}

const CSV = [
  'region,quarter,revenue,notes',
  'North,Q1,"1,204","Includes ""pilot"" accounts"',
  'North,Q2,"1,318",',
  'South,Q1,980,Late invoices',
  'South,Q2,"1,022",',
  'West,Q1,"1,511",',
].join('\n');

export const Csv = {
  render: (): ReactElement => (
    <Stage>
      <CsvViewer fileName="revenue.csv" source={CSV} />
    </Stage>
  ),
};

const GO = `package main

import "fmt"

// main prints the runbook's first step.
func main() {
\tfor step := 1; step <= 3; step++ {
\t\tfmt.Printf("step %d\\n", step)
\t}
}
`;

export const SourceCode = {
  render: (): ReactElement => (
    <Stage>
      <TextViewer fileName="main.go" source={GO} />
    </Stage>
  ),
};

const README = `# Deploy runbook

Run these steps in order. Each one is **idempotent**.

1. Build the image
2. Push to the registry
3. Roll the deployment

| Step | Owner | Time |
| --- | --- | --- |
| Build | CI | 4 min |
| Roll | On-call | 2 min |

> Rollback is the same steps with the previous tag.
`;

export const Markdown = {
  render: (): ReactElement => (
    <Stage>
      <MarkdownViewer fileName="README.md" source={README} />
    </Stage>
  ),
};

function SmallStage({ children }: { readonly children: ReactElement }): ReactElement {
  return (
    <div
      role="region"
      aria-label="Small file preview"
      className="flex h-96 w-64 max-w-full flex-col"
    >
      {children}
    </div>
  );
}

function checkContainedPreview(canvasElement: HTMLElement): void {
  const region = within(canvasElement).getByRole('region', { name: 'Small file preview' });
  if (region.scrollWidth > region.clientWidth)
    throw new Error('File content overflowed its narrow scroll container.');
}

export const SmallCsv = {
  render: (): ReactElement => (
    <SmallStage>
      <CsvViewer fileName="revenue.csv" source={CSV} />
    </SmallStage>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('table', { name: 'revenue.csv' });
    checkContainedPreview(canvasElement);
  },
};

export const SmallSourceCode = {
  render: (): ReactElement => (
    <SmallStage>
      <TextViewer fileName="main.go" source={GO} />
    </SmallStage>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByText('package main');
    checkContainedPreview(canvasElement);
  },
};

export const SmallMarkdown = {
  render: (): ReactElement => (
    <SmallStage>
      <MarkdownViewer fileName="README.md" source={README} />
    </SmallStage>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await within(canvasElement).findByRole('heading', { name: 'Deploy runbook' });
    checkContainedPreview(canvasElement);
  },
};
