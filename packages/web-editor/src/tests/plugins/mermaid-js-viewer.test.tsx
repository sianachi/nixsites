// design-token-exempt-file: literal theme colors and vendor SVG fixtures are regression assertions.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MermaidViewer } from '../../plugins/mermaid-js-viewer';
import { renderMermaid, subscribeToMermaidTheme } from '../../plugins/mermaid-render';

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  parse: vi.fn(),
}));

vi.mock('mermaid', () => ({ default: mermaid }));

const SVG = '<svg viewBox="0 0 400 200"><text>Core API</text></svg>';

beforeEach(() => {
  mermaid.initialize.mockReset();
  mermaid.render.mockReset().mockResolvedValue({ svg: SVG });
  mermaid.parse.mockReset().mockResolvedValue({ diagramType: 'flowchart-v2' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

describe('Mermaid previews', () => {
  it('uses readable strokes, markers and labels on the active dark ground, then follows a light choice', async () => {
    const root = document.documentElement;
    root.setAttribute('data-theme', 'dark');
    root.style.colorScheme = 'dark';
    root.style.setProperty('--color-bg', '#17181a');
    root.style.setProperty('--color-surface', '#1f2123');
    root.style.setProperty('--color-text', '#e8e9ea');
    root.style.setProperty('--color-accent', '#5980a6');
    render(<MermaidViewer fileName="dark.mmd" source="flowchart LR\nWeb --> Core" />);
    await screen.findByRole('img');
    expect(mermaid.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          darkMode: true,
          primaryColor: '#1f2123',
          primaryTextColor: '#e8e9ea',
          lineColor: '#e8e9ea',
          arrowheadColor: '#e8e9ea',
          actorLineColor: '#e8e9ea',
          signalColor: '#e8e9ea',
          labelTextColor: '#e8e9ea',
          pieStrokeColor: '#e8e9ea',
          pieOuterStrokeColor: '#e8e9ea',
          archEdgeColor: '#e8e9ea',
          archEdgeArrowColor: '#e8e9ea',
          archGroupBorderColor: '#e8e9ea',
        }) as unknown,
      }),
    );
    root.setAttribute('data-theme', 'light');
    root.style.colorScheme = 'light';
    root.style.setProperty('--color-text', '#1d1f20');
    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          themeVariables: expect.objectContaining({
            darkMode: false,
            lineColor: '#1d1f20',
          }) as unknown,
        }),
      );
    });
    await screen.findByRole('img');
  });

  it('renders with strict security and token-backed typography, and zooms the fitted diagram', async () => {
    document.documentElement.style.setProperty('--font-body', 'Nunito Sans, sans-serif');
    render(<MermaidViewer fileName="architecture.mmd" source="flowchart LR\nWeb --> Core" />);

    const diagram = await screen.findByRole('img', { name: 'architecture.mmd diagram' });
    const svg = diagram.querySelector('svg');
    expect(mermaid.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        htmlLabels: false,
        suppressErrorRendering: true,
        secure: expect.arrayContaining([
          'securityLevel',
          'htmlLabels',
          'maxTextSize',
          'maxEdges',
        ]) as unknown,
        themeVariables: expect.objectContaining({
          fontFamily: 'Nunito Sans, sans-serif',
        }) as unknown,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(diagram).toHaveStyle({ width: '125%' });
    expect(diagram.querySelector('svg')).toBe(svg);
    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(diagram).toHaveStyle({ width: '100%' });
    document.documentElement.style.setProperty('--font-body', 'system-ui, sans-serif');
    await waitFor(() => {
      expect(mermaid.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({
          themeVariables: expect.objectContaining({
            fontFamily: 'system-ui, sans-serif',
          }) as unknown,
        }),
      );
    });
    await screen.findByRole('img');
  });

  it('clears the previous image immediately when the source changes and rejects stale results', async () => {
    let completeOld: (value: { svg: string }) => void = () => undefined;
    let completeNew: (value: { svg: string }) => void = () => undefined;
    mermaid.render
      .mockResolvedValueOnce({ svg: SVG })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeNew = resolve;
          }),
      );
    const { rerender } = render(<MermaidViewer fileName="architecture.mmd" source="first" />);
    await screen.findByRole('img');
    rerender(<MermaidViewer fileName="architecture.mmd" source="second" />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Rendering');
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledTimes(2);
    });
    rerender(<MermaidViewer fileName="architecture.mmd" source="third" />);
    await act(async () => {
      completeOld({ svg: '<svg><text>Obsolete</text></svg>' });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByText('Obsolete')).not.toBeInTheDocument();
    await act(async () => {
      completeNew({ svg: '<svg><text>Current</text></svg>' });
      await Promise.resolve();
    });
    expect(await screen.findByRole('img')).toHaveTextContent('Current');
  });

  it('shows syntax failures honestly and keeps the source available', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Unexpected node on line 2'));
    render(<MermaidViewer fileName="broken.mmd" source="flowchart ???" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Unexpected node on line 2');
    expect(screen.getByRole('button', { name: 'Download SVG' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download Mermaid' })).toBeEnabled();
    expect(screen.getByText('flowchart ???')).toBeInTheDocument();
  });

  it('expands one image without duplicating SVG identities and restores the inline preview', async () => {
    const user = userEvent.setup();
    render(<MermaidViewer fileName="architecture.mmd" source="flowchart LR\nWeb --> Core" />);
    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: 'Expand diagram' }));
    const dialog = screen.getByRole('dialog', { name: 'architecture.mmd' });
    expect(within(dialog).getByRole('img')).toBeVisible();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Expand diagram' })).toHaveFocus();
  });

  it('opens the diagram context menu and fits a zoomed preview', async () => {
    render(<MermaidViewer fileName="architecture.mmd" source="flowchart LR\nWeb --> Core" />);
    const diagram = await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.contextMenu(screen.getByRole('region', { name: 'Scrollable diagram' }), {
      clientX: 20,
      clientY: 20,
    });
    const menu = screen.getByRole('menu', { name: 'Diagram actions' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Fit width' }));
    expect(diagram).toHaveStyle({ width: '100%' });
  });

  it('downloads the rendered SVG and current source, then releases the blob URLs', async () => {
    const create = vi.fn().mockReturnValue('blob:diagram');
    const revoke = vi.fn();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = revoke;
      },
    );
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true);
      downloads.push(this.download);
    });
    render(<MermaidViewer fileName="architecture.mmd" source="flowchart LR\nWeb --> Core" />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Download SVG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download Mermaid' }));
    expect(downloads).toEqual(['architecture.svg', 'architecture.mmd']);
    expect((create.mock.calls[0]?.[0] as Blob).type).toBe('image/svg+xml');
    expect((create.mock.calls[1]?.[0] as Blob).type).toBe('text/vnd.mermaid');
    expect(revoke).not.toHaveBeenCalled();
    frames.forEach((callback) => {
      callback(0);
    });
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});

describe('shared Mermaid runtime', () => {
  it('recolors hardcoded black connectors and marker fills in dark mode while retaining node fills and colored strokes', async () => {
    document.documentElement.style.colorScheme = 'dark';
    document.documentElement.style.setProperty('--color-text', '#e8e9ea');
    mermaid.render.mockResolvedValueOnce({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><line stroke="black"/><path stroke="#000000"/><defs><marker><path fill="black" stroke="#000"/><polygon points="0 0, 10 5, 0 10"/></marker></defs><rect fill="black" stroke="#5980a6"/></svg>',
    });
    const result = new DOMParser().parseFromString(
      await renderMermaid('source', 'dark'),
      'image/svg+xml',
    );
    expect(result.querySelector('line')?.getAttribute('stroke')).toBe('#e8e9ea');
    expect(result.querySelector('svg > path')?.getAttribute('stroke')).toBe('#e8e9ea');
    expect(result.querySelector('marker path')?.getAttribute('stroke')).toBe('#e8e9ea');
    expect(result.querySelector('marker path')?.getAttribute('fill')).toBe('#e8e9ea');
    expect(result.querySelector('marker polygon')?.getAttribute('fill')).toBe('#e8e9ea');
    expect(result.querySelector('rect')?.getAttribute('stroke')).toBe('#5980a6');
    expect(result.querySelector('rect')?.getAttribute('fill')).toBe('black');
  });

  it('subscribes to system theme changes and removes its subscription when released', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const media = { addEventListener, removeEventListener };
    const matchMedia = vi.fn().mockReturnValue(media);
    vi.stubGlobal('matchMedia', matchMedia);
    const changed = vi.fn();
    const release = subscribeToMermaidTheme(changed);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(addEventListener).toHaveBeenCalledWith('change', changed);
    release();
    expect(removeEventListener).toHaveBeenCalledWith('change', changed);
  });

  it('serializes renders and continues after a failed render', async () => {
    let rejectFirst: (reason: Error) => void = () => undefined;
    mermaid.render.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectFirst = reject;
        }),
    );
    const first = renderMermaid('first', 'first');
    const rejected = expect(first).rejects.toThrow('Invalid source');
    const second = renderMermaid('second', 'second');
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledTimes(1);
    });
    expect(mermaid.parse).not.toHaveBeenCalled();
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('Invalid source'));
    await rejected;
    await second;
    expect(mermaid.render).toHaveBeenLastCalledWith('second', 'second');
    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
  });
});
