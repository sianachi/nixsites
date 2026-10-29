import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { fenced } from '../../openui/fence';
import { previewProgram } from '../../openui/preview-program';
import { ApprovalSummary } from '../../pets/approval/approval-summary';

const workspace = '11111111-1111-4111-8111-111111111111';
const flat = {
  itemId: '',
  parentId: '',
  title: '',
  markdown: '',
  query: '',
  propertiesJson: '',
  specJson: '',
};
function model(counts: Partial<Record<'items' | 'fields' | 'views' | 'entries', number>>) {
  return {
    headline: 'I will change things',
    destination: { title: 'Home', path: [] },
    counts: { items: 0, fields: 0, views: 0, entries: 0, writes: 1, ...counts },
    tree: [],
    notes: [],
    warnings: [],
    problems: [],
    neverDoes: [],
  };
}

describe('approval summaries', () => {
  it('say nothing when the preview has nothing to add', () => {
    expect(previewProgram({ ...flat, operation: 'create_note', title: 'Plan' })).toBeNull();
  });

  it('list property values, quoted safely, without repeating the preview counts', async () => {
    const program = previewProgram({
      ...flat,
      operation: 'set_properties',
      propertiesJson: JSON.stringify({ 'Status") ; root = X("': 'Done', Done: true }),
    });
    expect(program).not.toContain('Stat(');
    render(
      <MemoryRouter>
        <ApprovalSummary
          model={model({ items: 1, fields: 2, views: 1 })}
          args={{
            ...flat,
            operation: 'set_properties',
            propertiesJson: JSON.stringify({ 'Status") ; root = X("': 'Done', Done: true }),
          }}
          workspaceId={workspace}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Status") ; root = X("')).toBeInTheDocument();
    expect(screen.getByText('yes')).toBeInTheDocument();
    expect(screen.queryByText('Fields')).not.toBeInTheDocument();
  });

  it('run a generated-UI program before and after a body edit, side by side', async () => {
    render(
      <MemoryRouter>
        <ApprovalSummary
          model={{
            ...model({}),
            bodyEdit: {
              scope: 'section',
              subject: 'Counter',
              before: fenced('root = Stack([t])\nt = Text("Old screen", "display")'),
              after: fenced('root = Stack([t])\nt = Text("New screen", "display")'),
              blocksRemoved: 1,
              blocksAdded: 1,
              losesFormatting: false,
            },
          }}
          args={{
            ...flat,
            operation: 'replace_passage',
            itemId: workspace,
            query: 'Old',
            markdown: 'New',
          }}
          workspaceId={workspace}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Old screen')).toBeInTheDocument();
    expect(screen.getByText('New screen')).toBeInTheDocument();
    expect(screen.getByText(/^After this change/)).toBeInTheDocument();
  });
});
