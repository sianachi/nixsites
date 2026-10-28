import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyCaptureDialog } from '../../daily-notes/daily-capture-dialog';

const io = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn(), append: vi.fn() }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => io }));
vi.mock('@nix/companion', () => ({ createCompanionBodies: () => ({ append: io.append }) }));

beforeEach(() => {
  io.query.mockReset().mockResolvedValue({ rolloverHour: 0, template: '# Daily template' });
  io.execute.mockReset().mockResolvedValue({ itemId: 'daily-note', created: true });
  io.append.mockReset().mockResolvedValue(undefined);
});

function openCapture(): {
  user: ReturnType<typeof userEvent.setup>;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  render(
    <DailyCaptureDialog
      open
      workspaceId="workspace"
      onClose={close}
      onOpenItem={() => undefined}
    />,
  );
  return { user: userEvent.setup(), close };
}

describe('daily quick capture', () => {
  it('prepends the template only when it creates the note, preserving typed lines', async () => {
    const { user, close } = openCapture();
    await user.type(screen.getByRole('textbox'), 'First line{Enter}Second line');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(io.append).toHaveBeenCalledWith(
        'daily-note',
        '# Daily template\n\nFirst line\n\nSecond line',
        expect.any(AbortSignal),
      );
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it('appends to an existing note without inserting the template again', async () => {
    io.execute.mockResolvedValue({ itemId: 'daily-note', created: false });
    const { user } = openCapture();
    await user.type(screen.getByRole('textbox'), 'Another thought');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(io.append).toHaveBeenCalledWith(
        'daily-note',
        'Another thought',
        expect.any(AbortSignal),
      );
    });
  });

  it('keeps the draft and explains a failed collaborative write', async () => {
    io.append.mockRejectedValue(new Error('Disconnected'));
    const { user, close } = openCapture();
    await user.type(screen.getByRole('textbox'), 'Keep this thought');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was added');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this thought');
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(close).not.toHaveBeenCalled();
  });
});
