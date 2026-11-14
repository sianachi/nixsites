import type { Editor } from '@tiptap/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { SuggestingControl } from '../../editor/toolbar';

function editorWith(acceptAll = vi.fn()): Editor {
  return { commands: { acceptAllSuggestions: acceptAll, rejectAllSuggestions: vi.fn() } } as never;
}

it('offers the Suggesting switch while suggesting is allowed', () => {
  render(
    <SuggestingControl
      editor={editorWith()}
      suggesting={false}
      pending={false}
      onToggle={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Suggesting' })).toBeVisible();
});

it('drops the switch when suggesting is off but keeps Accept all and Reject all for suggestions already there', async () => {
  const acceptAll = vi.fn();
  render(
    <SuggestingControl
      editor={editorWith(acceptAll)}
      suggesting={false}
      canToggle={false}
      pending
      onToggle={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Suggesting' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Accept all' }));
  expect(acceptAll).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Reject all' })).toBeVisible();
});
