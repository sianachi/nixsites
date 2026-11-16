import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FloatingMenuAnchor } from '../primitives/placement';
import { useAnchoredPanel } from './use-anchored-panel';

function Panel({ anchor }: { readonly anchor: () => FloatingMenuAnchor }) {
  const ref = useRef<HTMLDivElement>(null);
  useAnchoredPanel(ref, anchor, null);
  return (
    <div role="region" aria-label="Scroller">
      <div ref={ref} popover="manual" role="dialog" aria-label="Tools" />
    </div>
  );
}

function viewport(desktop: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches: desktop }));
  const bounds = Object.assign(new EventTarget(), {
    offsetLeft: 30,
    offsetTop: 100,
    width: 240,
    height: 300,
  });
  vi.stubGlobal('visualViewport', bounds);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 240, 160),
  );
  const getStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = getStyle(element, pseudo);
    if (style.minWidth === '') style.minWidth = '220px';
    return style;
  });
  return bounds;
}

describe('useAnchoredPanel', () => {
  // A frame that runs at once, so each test reads the placement right after its event.
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => {
      run(0);
      return 0;
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('places once per frame for a burst of scroll and resize events, and not after closing', () => {
    viewport(true);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run));
    const cancelled = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelled);
    let top = 140;
    const anchor = vi.fn(() => ({ left: 40, top, bottom: top + 20 }));
    const view = render(<Panel anchor={anchor} />);
    const panel = screen.getByRole('dialog', { name: 'Tools' });
    const placedAtOpen = anchor.mock.calls.length;
    expect(panel.style.top).toBe('164px');

    top = 150;
    fireEvent.scroll(screen.getByRole('region', { name: 'Scroller' }));
    window.dispatchEvent(new Event('resize'));
    fireEvent.scroll(screen.getByRole('region', { name: 'Scroller' }));
    expect(frames).toHaveLength(1);
    expect(panel.style.top).toBe('164px');
    frames.shift()?.(0);
    expect(panel.style.top).toBe('174px');
    expect(anchor.mock.calls.length).toBe(placedAtOpen + 1);

    window.dispatchEvent(new Event('resize'));
    view.unmount();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('places mobile sheets inside the visual viewport above the keyboard and updates its size', () => {
    const bounds = viewport(false);
    render(<Panel anchor={() => ({ left: 0, top: 0, bottom: 0 })} />);
    const panel = screen.getByRole('dialog', { name: 'Tools' });
    expect(panel).toHaveStyle({
      width: '240px',
      maxWidth: '240px',
      minWidth: '0',
      maxHeight: '210px',
      left: '30px',
      top: '240px',
      bottom: 'auto',
    });
    bounds.width = 180;
    bounds.offsetTop = 200;
    bounds.dispatchEvent(new Event('resize'));
    expect(panel).toHaveStyle({ width: '180px', maxWidth: '180px', top: '340px' });
  });

  it('caps desktop width, including the reading measure, to a pinched visual viewport', () => {
    const bounds = viewport(true);
    bounds.width = 140;
    render(<Panel anchor={() => ({ left: 300, top: 180, bottom: 200 })} />);
    expect(screen.getByRole('dialog', { name: 'Tools' })).toHaveStyle({
      minWidth: '124px',
      maxWidth: '124px',
      left: '38px',
    });
  });

  it('follows an anchor when its ancestor scrolls, while scrolling the panel keeps its position', () => {
    viewport(true);
    let top = 140;
    render(<Panel anchor={() => ({ left: 40, top, bottom: top + 20 })} />);
    const panel = screen.getByRole('dialog', { name: 'Tools' });
    expect(panel.style.top).toBe('164px');
    top = 150;
    fireEvent.scroll(screen.getByRole('region', { name: 'Scroller' }));
    expect(panel.style.top).toBe('174px');
    top = 160;
    panel.scrollTop = 30;
    fireEvent.scroll(panel);
    expect(panel.style.top).toBe('174px');
    expect(panel.scrollTop).toBe(30);
  });

  it('clears mobile dimensions when the viewport crosses to desktop', () => {
    viewport(false);
    render(<Panel anchor={() => ({ left: 40, top: 140, bottom: 160 })} />);
    const panel = screen.getByRole('dialog', { name: 'Tools' });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    fireEvent.resize(window);
    expect(panel.style.width).toBe('');
    expect(panel.style.bottom).toBe('');
    expect(panel.style.maxWidth).toBe('224px');
    expect(panel.style.top).toBe('164px');
  });
});
