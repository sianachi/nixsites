import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UndoProvider, UndoBar } from '@nix/ui';
import { describe, expect, it, vi } from 'vitest';

import { ItemHeader } from '../../pages/editor/item-header';
import type { ShellContext } from '../../shell/shell-context';

function setup() {
  const rename = vi.fn(() => Promise.resolve());
  const tree = { breadcrumbs: () => [], rename } as unknown as ShellContext['tree'];
  render(
    <UndoProvider>
      <ItemHeader
        reading={false}
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
  return { rename, input: screen.getByRole('textbox', { name: 'Note title' }) };
}

describe('item header rename', () => {
  it('renames on blur and can be undone', async () => {
    const user = userEvent.setup();
    const { rename, input } = setup();
    await user.clear(input);
    await user.type(input, 'Plan B{Enter}');
    expect(rename).toHaveBeenCalledWith('n1', 'Plan B');
    await user.click(await screen.findByRole('button', { name: /undo/i }));
    expect(rename).toHaveBeenLastCalledWith('n1', 'Plan');
  });

  it('Escape reverts without saving', async () => {
    const user = userEvent.setup();
    const { rename, input } = setup();
    await user.type(input, 'x{Escape}');
    expect(rename).not.toHaveBeenCalled();
    expect(input).toHaveValue('Plan');
  });

  it('refuses an empty title and says why', async () => {
    const user = userEvent.setup();
    const { rename, input } = setup();
    await user.clear(input);
    await user.tab();
    expect(rename).not.toHaveBeenCalled();
    expect(input).toHaveValue('Plan');
    expect(screen.getByText('A note needs a title')).toBeInTheDocument();
  });
});
