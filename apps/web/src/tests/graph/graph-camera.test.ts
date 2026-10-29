import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readArrangement, writeArrangement } from '../../graph/graph-arrangement';
import { cameraOf, fitCamera, viewOf, zoomAbout } from '../../graph/graph-camera';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';

describe('a chosen view', () => {
  it('round-trips through the pane it was made in', () => {
    const pane = { width: 800, height: 600 };
    const camera = { x: 120, y: -40, scale: 1.5 };

    expect(cameraOf(viewOf(camera, pane), pane)).toEqual(camera);
  });

  it('stays centred when the pane is wider than the one it was made in', () => {
    const drawing = { width: 400, height: 300 };
    const narrow = { width: 500, height: 400 };
    const wide = { width: 1400, height: 400 };
    const fitted = fitCamera(drawing, narrow);
    const zoomed = zoomAbout(fitted, 2, narrow.width / 2, narrow.height / 2);

    const restored = cameraOf(viewOf(zoomed, narrow), wide);

    // The drawing's own centre is still at the middle of the wider pane.
    expect(restored.x + (drawing.width / 2) * restored.scale).toBeCloseTo(wide.width / 2);
    expect(restored.y + (drawing.height / 2) * restored.scale).toBeCloseTo(wide.height / 2);
    expect(restored.scale).toBe(2);
  });
});

describe('the stored arrangement', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a view and opens an entry from before views fitted rather than off-centre', () => {
    const view = { centreX: 10, centreY: 20, scale: 0.5 };
    writeArrangement('workspace-a', { offsets: new Map(), collapsed: new Set(['n1']), view });
    expect(readArrangement('workspace-a', new Set(['n1'])).view).toEqual(view);

    storage.setItem(
      'nix.graph-arrangement',
      JSON.stringify({
        'workspace-b': { offsets: {}, collapsed: ['n1'], camera: { x: -300, y: 0, scale: 1 } },
      }),
    );
    const legacy = readArrangement('workspace-b', new Set(['n1']));
    expect(legacy.view).toBeNull();
    expect([...legacy.collapsed]).toEqual(['n1']);
  });
});
