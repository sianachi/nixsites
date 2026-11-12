import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UndoProvider, UndoBar } from '@nix/ui';
import { describe, expect, it, vi } from 'vitest';

import { ItemHeader } from '../../pages/editor/item-header';
import type { ShellContext } from '../../shell/shell-context';

function setup(titleInBody = false) {
  const rename = vi.fn(() => Promise.resolve());
  const tree = { breadcrumbs: () => [], rename } as unknown as ShellContext['tree'];
  render(
    <UndoProvider>
      <ItemHeader
        reading={false}
        titleInBody={titleInBody}
        trailing={null}
        tree={tree}
        itemId="n1"
        title="Plan"
        bodyKind="note"
        onNavigate={vi.fn()}
        onCommit={vi.fn()}
      />
      <UndoBar />
    </UndoProvider>,
  );
  return { rename };
}

describe('item header rename', () => {
  it('renames on blur and can be undone', async () => {
    const user = userEvent.setup();
    const { rename } = setup();
    const input = screen.getByRole('textbox', { name: 'Note title' });
    await user.clear(input);
    await user.type(input, 'Plan B{Enter}');
    expect(rename).toHaveBeenCalledWith('n1', 'Plan B');
    await user.click(await screen.findByRole('button', { name: /undo/i }));
    expect(rename).toHaveBeenLastCalledWith('n1', 'Plan');
  });

  it('Escape reverts without saving', async () => {
    const user = userEvent.setup();
    const { rename } = setup();
    const input = screen.getByRole('textbox', { name: 'Note title' });
    await user.type(input, 'x{Escape}');
    expect(rename).not.toHaveBeenCalled();
    expect(input).toHaveValue('Plan');
  });

  it('refuses an empty title and says why', async () => {
    const user = userEvent.setup();
    const { rename } = setup();
    const input = screen.getByRole('textbox', { name: 'Note title' });
    await user.clear(input);
    await user.tab();
    expect(rename).not.toHaveBeenCalled();
    expect(input).toHaveValue('Plan');
    expect(screen.getByText('A note needs a title')).toBeInTheDocument();
  });

  it('keeps the title editable when the matching heading already shows in the document', async () => {
    const user = userEvent.setup();
    const { rename } = setup(true);
    expect(screen.queryByRole('textbox', { name: 'Note title' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename note' }));
    const input = screen.getByRole('textbox', { name: 'Note title' });
    expect(input).toHaveValue('Plan');
    expect(input).toHaveFocus();
    await user.type(input, 'Renamed plan{Enter}', { skipClick: true });
    expect(rename).toHaveBeenCalledWith('n1', 'Renamed plan');
  });
});
