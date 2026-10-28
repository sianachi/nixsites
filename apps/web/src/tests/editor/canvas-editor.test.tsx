import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasElement } from '../../editor/canvas-binding';
import { CanvasEditor } from '../../editor/canvas-editor';
import type { NixCanvasProps } from '../../editor/nix-canvas';
import { stubViewport } from '../stub-viewport';

const canvasHarness = vi.hoisted(() => ({
  props: null as NixCanvasProps | null,
  rendered: vi.fn(),
  destroyed: vi.fn(),
  getAccessToken: vi.fn(() => Promise.resolve('token')),
}));

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken: canvasHarness.getAccessToken }),
}));

vi.mock('@nix/web-foundation/lib/session-store', () => ({
  useSessionStore: (selector: (state: { profile: { name: string } }) => unknown) =>
    selector({ profile: { name: 'Test person' } }),
}));

vi.mock('../../editor/collab-sync', () => ({
  startCollabSync: () => ({ destroy: canvasHarness.destroyed }),
}));

vi.mock('../../editor/presence-list', () => ({
  PresenceList: () => null,
}));

vi.mock('../../editor/nix-canvas', async () => {
  const React = await import('react');
  return {
    NixCanvas: (props: NixCanvasProps): React.ReactNode => {
      canvasHarness.rendered();
      canvasHarness.props = props;
      return React.createElement(
        'div',
        { 'data-testid': 'canvas-elements' },
        props.elements.map((element) => element.id).join(','),
      );
    },
  };
});

function currentCanvasProps(): NixCanvasProps {
  if (canvasHarness.props === null) throw new Error('The canvas has not rendered.');
  return canvasHarness.props;
}

function element(id: string): CanvasElement {
  return { id, type: 'rectangle', version: 1, versionNonce: 1, index: 'a0' };
}

describe('canvas document identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasHarness.props = null;
  });

  it('replaces the Y.Doc when the item changes instead of carrying the old scene across', async () => {
    const view = render(
      <MemoryRouter>
        <CanvasEditor itemId="10000000-0000-4000-8000-000000000001" />
      </MemoryRouter>,
    );
    await screen.findByTestId('canvas-elements');
    const firstAwareness = currentCanvasProps().awareness;

    act(() => {
      currentCanvasProps().onChange([element('from-first-canvas')]);
    });
    expect(await screen.findByTestId('canvas-elements')).toHaveTextContent('from-first-canvas');

    view.rerender(
      <MemoryRouter>
        <CanvasEditor itemId="20000000-0000-4000-8000-000000000002" />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('canvas-elements')).toBeEmptyDOMElement();
    });
    expect(currentCanvasProps().awareness).not.toBe(firstAwareness);
    expect(canvasHarness.destroyed).toHaveBeenCalledOnce();
  });

  it('does not rerender the editor for an unchanged Excalidraw scene callback', async () => {
    render(
      <MemoryRouter>
        <CanvasEditor itemId="10000000-0000-4000-8000-000000000001" />
      </MemoryRouter>,
    );
    const first = element('drawn-shape');

    act(() => {
      currentCanvasProps().onChange([first]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('canvas-elements')).toHaveTextContent('drawn-shape');
    });
    const rendersAfterChange = canvasHarness.rendered.mock.calls.length;

    act(() => {
      currentCanvasProps().onChange([first]);
    });

    expect(canvasHarness.rendered).toHaveBeenCalledTimes(rendersAfterChange);
  });

  it('starts phones in contents and preserves the live scene when switching presentation', async () => {
    stubViewport(280);
    render(
      <MemoryRouter>
        <CanvasEditor itemId="10000000-0000-4000-8000-000000000001" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('searchbox', { name: 'Find in canvas' })).toBeInTheDocument();
    expect(canvasHarness.props).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Spatial canvas' }));
    await screen.findByTestId('canvas-elements');
    const firstAwareness = currentCanvasProps().awareness;
    const spatialElement = screen.getByTestId('canvas-elements');
    act(() => {
      currentCanvasProps().onChange([
        { id: 'text', type: 'text', text: 'A phone canvas note', version: 1, versionNonce: 1 },
      ]);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Contents' }));
    expect(screen.getByText('A phone canvas note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Spatial canvas' }));
    expect(await screen.findByTestId('canvas-elements')).toBe(spatialElement);
    expect(spatialElement).toHaveTextContent('text');
    expect(currentCanvasProps().awareness).toBe(firstAwareness);
    expect(canvasHarness.destroyed).not.toHaveBeenCalled();
  });
});
