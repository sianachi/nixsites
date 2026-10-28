import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemInsertDialog } from '@nix/web-editor/editor/item-insert-dialog';
const harness = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), select: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => harness }));
vi.mock('@nix/web-platform/routing/selected-item', () => ({ useSelectedItem: () => harness }));
const common = {
  workspaceId: 'workspace',
  parentId: 'parent',
  onCancel: vi.fn(),
  onInsert: vi.fn(() => true),
  onFiles: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  common.onInsert.mockReturnValue(true);
});
describe('item insertion', () => {
  it('offers only matching items from the current workspace and keeps partial search results honest', async () => {
    harness.query.mockResolvedValue({
      query: 'design',
      results: [
        { id: 'note', title: 'Design decisions', type: 'note', workspaceId: 'workspace' },
        { id: 'other', title: 'Other workspace', type: 'note', workspaceId: 'elsewhere' },
        { id: 'file', title: 'Design PDF', type: 'file', workspaceId: 'workspace' },
      ],
      truncated: true,
    });
    render(<ItemInsertDialog {...common} kind="embed" />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Search this workspace' }), 'design');
    await user.click(await screen.findByRole('button', { name: 'Design decisions' }));
    expect(common.onInsert).toHaveBeenCalledWith('note', 'embed', 'Design decisions');
    expect(screen.queryByRole('button', { name: 'Other workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Design PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('More matches exist');
  });
  it('keeps a created child discoverable if the editor can no longer insert its card', async () => {
    harness.execute.mockResolvedValue({ id: 'new-page', title: 'Research' });
    common.onInsert.mockReturnValue(false);
    render(<ItemInsertDialog {...common} kind="subpage" />);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Page title' }), 'Research');
    await user.click(screen.getByRole('button', { name: 'Create page' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Your page was created'),
    );
    await user.click(screen.getByRole('button', { name: 'Open page' }));
    expect(harness.select).toHaveBeenCalledWith('new-page');
    expect(screen.getByRole('button', { name: 'Create page' })).toBeDisabled();
    expect(common.onCancel).not.toHaveBeenCalled();
  });
  it('accepts a batch of files without asking for addresses', async () => {
    render(<ItemInsertDialog {...common} kind="attachment" />);
    const files = [
      new File(['one'], 'one.pdf', { type: 'application/pdf' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ];
    await userEvent.setup().upload(screen.getByLabelText('Upload files'), files);
    expect(common.onFiles).toHaveBeenCalledWith(files);
  });
});
