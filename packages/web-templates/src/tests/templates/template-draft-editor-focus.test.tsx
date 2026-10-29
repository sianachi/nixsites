import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import {
  TemplateDraftEditor,
  type TemplateItemEdits,
} from '../../templates/draft/template-draft-editor';
import type { TemplateItem } from '../../templates/template-api';

const CHILD: TemplateItem = {
  sourceId: 'a2222222-2222-4222-8222-222222222222',
  itemType: 'note',
  title: 'Daily check-in',
  seq: '2000',
  properties: null,
  schema: null,
  views: null,
  children: [],
  hasBody: false,
  recurrence: null,
};

const ROOT: TemplateItem = {
  sourceId: 'a1111111-1111-4111-8111-111111111111',
  itemType: 'note',
  title: 'Team tracker',
  seq: '1000',
  properties: null,
  schema: null,
  views: null,
  children: [CHILD],
  hasBody: false,
  recurrence: null,
};

function EditableTree(): ReactNode {
  const [selected, setSelected] = useState(ROOT.sourceId);
  const [edits, setEdits] = useState<TemplateItemEdits>({});
  return (
    <TemplateDraftEditor
      root={ROOT}
      edits={edits}
      selectedSourceId={selected}
      templateId="a3333333-3333-4333-8333-333333333333"
      operationId="a4444444-4444-4444-8444-444444444444"
      bodySync={null}
      onBodySync={() => undefined}
      onSelect={setSelected}
      onChange={(sourceId, edit) => {
        setEdits((current) => ({ ...current, [sourceId]: edit }));
      }}
    />
  );
}

describe('the template draft item tree', () => {
  it('moves focus into the selected item editor instead of leaving it on disabled navigation', async () => {
    // Focus moves in an effect that lands a macrotask after the click; keep user-event's yield.
    const user = userEvent.setup({ delay: 0 });
    render(<EditableTree />);

    await user.click(screen.getByRole('button', { name: CHILD.title }));

    const itemName = screen.getByRole('textbox', { name: 'Item name' });
    expect(itemName).toHaveValue(CHILD.title);
    expect(itemName).toHaveFocus();
    expect(screen.getByRole('button', { name: CHILD.title })).toBeDisabled();
  });
});
