import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NoteImageView } from '@nix/web-editor/editor/note-image-view';

const apiClient = vi.hoisted(() => ({}));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => apiClient }));
vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
}));

function props(width: unknown, editable = true, fileItemId?: string) {
  return {
    node: { attrs: { src: 'https://example.test/image.png', alt: 'Diagram', width, fileItemId } },
    editor: { isEditable: editable },
    selected: true,
    updateAttributes: vi.fn(),
  } as unknown as Parameters<typeof NoteImageView>[0];
}
describe('note image sizing', () => {
  it('renders the saved width and saves proportional sizing and reset', () => {
    const viewProps = props(240);
    render(<NoteImageView {...viewProps} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('width', '240');
    fireEvent.change(screen.getByRole('slider', { name: 'Image width' }), {
      target: { value: '320' },
    });
    expect(viewProps.updateAttributes).toHaveBeenCalledWith({ width: 320, height: null });
    fireEvent.click(screen.getByRole('button', { name: 'Reset size' }));
    expect(viewProps.updateAttributes).toHaveBeenCalledWith({ width: null, height: null });
  });

  it('preserves sizing in read-only notes without offering editing controls', () => {
    render(<NoteImageView {...props(240, false)} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).toHaveAttribute('width', '240');
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('ignores malformed dimensions', () => {
    render(<NoteImageView {...props(-20)} />);
    expect(screen.getByRole('img', { name: 'Diagram' })).not.toHaveAttribute('width');
  });
});
