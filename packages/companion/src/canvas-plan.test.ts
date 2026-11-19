import { describe, expect, it } from 'vitest';
import { compileCanvasPlan, invertCanvasChanges } from './canvas-plan.js';

const itemId = '0b2e6724-a955-4027-908d-37e283040101';
const start = { id: 'start', type: 'rectangle', x: 0, y: 0, width: 180, height: 80 };
const finish = { id: 'finish', type: 'diamond', x: 280, y: 0, width: 160, height: 80 };
const label = { id: 'start-label', type: 'text', text: 'Start', containerId: 'start' };
const arrow = { id: 'connection', type: 'arrow', from: 'start', to: 'finish' };

describe('native canvas plans', () => {
  it('builds editable, bound Excalidraw elements with group and Nix card metadata', () => {
    const changes = compileCanvasPlan(
      [],
      {
        elements: [
          { ...start, nixItemId: itemId, groupIds: ['flow'] },
          { ...finish, groupIds: ['flow'] },
          label,
          arrow,
          {
            id: 'stroke',
            type: 'freedraw',
            points: [
              [150, 100],
              [160, 90],
              [170, 100],
            ],
          },
        ],
      },
      10,
    );
    expect(changes.map(({ before }) => before)).toEqual([null, null, null, null, null]);
    const elements = new Map(changes.map(({ after }) => [after.id, after]));
    expect(elements.get('start')).toMatchObject({
      type: 'rectangle',
      groupIds: ['flow'],
      version: 1,
      link: `nix://item/${itemId}`,
      customData: { nix: { kind: 'item', itemId } },
      boundElements: [
        { id: 'start-label', type: 'text' },
        { id: 'connection', type: 'arrow' },
      ],
    });
    expect(elements.get('connection')).toMatchObject({
      type: 'arrow',
      x: 188,
      y: 40,
      points: [
        [0, 0],
        [84, 0],
      ],
      startBinding: { elementId: 'start', focus: 0, gap: 8 },
      endBinding: { elementId: 'finish', focus: 0, gap: 8 },
    });
    expect(elements.get('start-label')).toMatchObject({
      type: 'text',
      containerId: 'start',
      text: 'Start',
    });
    expect(elements.get('stroke')).toMatchObject({
      type: 'freedraw',
      points: [
        [0, 0],
        [10, -10],
        [20, 0],
      ],
      simulatePressure: true,
    });
  });

  it('moves a box and its connector, then undoes the proposal without touching a separate edit', () => {
    const scene = compileCanvasPlan([], { elements: [start, finish, label, arrow] }, 10).map(
      ({ after }) => after,
    );
    const changed = compileCanvasPlan(scene, { elements: [{ ...start, x: 30 }] }, 20);
    expect(changed.map(({ after }) => after.id).sort()).toEqual([
      'connection',
      'start',
      'start-label',
    ]);
    expect(changed.find(({ after }) => after.id === 'connection')?.after).toMatchObject({
      x: 218,
      y: 40,
      points: [
        [0, 0],
        [54, 0],
      ],
      version: 2,
    });
    const next = scene.map(
      (element) =>
        changed.find(({ after }) => element.id === after.id)?.after ?? { ...element, version: 2 },
    );
    const undo = invertCanvasChanges(next, changed, 30);
    expect(undo.map(({ after }) => after.id).sort()).toEqual([
      'connection',
      'start',
      'start-label',
    ]);
    expect(undo.find(({ after }) => after.id === 'start')?.after).toMatchObject({
      x: 0,
      version: 3,
    });
    const contested = next.map((element) =>
      element.id === 'start' ? { ...element, x: 60, version: 3 } : element,
    );
    expect(() => invertCanvasChanges(contested, changed, 30)).toThrow('changed since this action');
  });

  it('detaches a removed box and guards locked or invalid proposals', () => {
    const scene = compileCanvasPlan([], { elements: [start, finish, label, arrow] }, 10).map(
      ({ after }) => after,
    );
    const removal = compileCanvasPlan(scene, { remove: ['start'] }, 20);
    expect(removal.find(({ after }) => after.id === 'start-label')?.after.isDeleted).toBe(true);
    expect(removal.find(({ after }) => after.id === 'connection')?.after.startBinding).toBeNull();
    expect(() => compileCanvasPlan([], { elements: [start, start] }, 20)).toThrow('only once');
    expect(() =>
      compileCanvasPlan([], { elements: [{ ...start, link: 'https://example.org' }] }, 20),
    ).toThrow();
    expect(() =>
      compileCanvasPlan(
        scene.map((element) => ({ ...element, locked: true })),
        { elements: [{ ...start, x: 30 }] },
        20,
      ),
    ).toThrow('locked in the drawing');
  });
});
