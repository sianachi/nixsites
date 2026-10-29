import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CoverPickerDialog } from '../../../gallery/cover-picker-dialog';

function mount(onClose: () => void = () => undefined) {
  return render(
    <CoverPickerDialog
      itemTitle="Project plan"
      hasCover={false}
      canUpload
      onClose={onClose}
      onUpload={vi.fn().mockResolvedValue(undefined)}
      onSetAddress={vi.fn().mockResolvedValue(undefined)}
      onRemove={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

describe('a stray tap outside the sheet, with an address mid-type', () => {
  it('keeps the typed address instead of silently discarding it', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Image URL' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Image address' }), {
      target: { value: 'https://example.test/cover.png' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Discard what you typed?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(screen.getByRole('textbox', { name: 'Image address' })).toHaveValue(
      'https://example.test/cover.png',
    );
  });

  it('discards through the prompt and closes only then', () => {
    const onClose = vi.fn();
    mount(onClose);
    fireEvent.click(screen.getByRole('button', { name: 'Image URL' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Image address' }), {
      target: { value: 'https://example.test/cover.png' },
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not prompt when nothing has been typed', () => {
    const onClose = vi.fn();
    mount(onClose);

    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Discard what you typed?')).not.toBeInTheDocument();
  });
});
