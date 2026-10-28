import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

/**
 * The body axis choosing its editor: `item.type` says how the body is drawn, a canvas
 * draws as a scene, and everything unheard of draws as prose - the same open-set rule the
 * server applies, so the two never disagree about what a body is.
 */

// The real canvas editor has browser-only collaboration dependencies; what this suite asserts is the
// routing seam in front of it, so a marker stands in.
vi.mock('@nix/web-editor/editor/canvas-editor', () => ({
  CanvasEditor: ({ itemId }: { itemId: string }) => (
    <div aria-label="Canvas body">canvas {itemId}</div>
  ),
}));

vi.mock('../../views/sheet/sheet-editor', () => ({
  SheetEditor: ({ itemId }: { itemId: string }) => (
    <div aria-label="Spreadsheet body">spreadsheet {itemId}</div>
  ),
}));

beforeEach(() => {
  signedIn();
});

const DRAWING = item({
  id: '3c3c3c3c-3333-4333-8333-3c3c3c3c3c3c',
  title: 'Architecture sketch',
  type: 'canvas',
});

const NOTE = item({
  id: '3d3d3d3d-3333-4333-8333-3d3d3d3d3d3d',
  title: 'Plain words',
});

const SPREADSHEET = item({
  id: '3e3e3e3e-3333-4333-8333-3e3e3e3e3e3e',
  title: 'Capacity plan',
  type: 'spreadsheet',
});

describe('opening a canvas item', () => {
  it('draws the canvas editor for a canvas body, not the prose one', async () => {
    stubCoreApi({ items: [DRAWING] });
    renderAt(<App />, `/?item=${DRAWING.id}`);

    expect(await screen.findByLabelText('Canvas body')).toHaveTextContent(DRAWING.id);
    expect(screen.getByRole('textbox', { name: 'Canvas title' })).toHaveValue(DRAWING.title);
    expect(screen.queryByLabelText('Note body')).toBeNull();
  });

  it('labels a spreadsheet body and its title by the item kind', async () => {
    stubCoreApi({ items: [SPREADSHEET] });
    renderAt(<App />, `/?item=${SPREADSHEET.id}`);

    expect(await screen.findByLabelText('Spreadsheet body')).toHaveTextContent(SPREADSHEET.id);
    expect(screen.getByRole('textbox', { name: 'Spreadsheet title' })).toHaveValue(
      SPREADSHEET.title,
    );
    expect(screen.queryByRole('textbox', { name: 'Note title' })).not.toBeInTheDocument();
  });

  it('still opens a note as prose, and an unknown kind as prose too', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/?item=${NOTE.id}`);

    expect(await screen.findByLabelText('Note body')).toBeInTheDocument();
    expect(screen.queryByLabelText('Canvas body')).toBeNull();
  });
});
