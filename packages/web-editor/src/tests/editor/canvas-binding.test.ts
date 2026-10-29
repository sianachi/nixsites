import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createCanvasBinding,
  supersedes,
  type CanvasBinding,
  type CanvasElement,
} from '../../editor/canvas-binding';

/**
 * The scene bridge's contract: whole-element writes ordered by the native canvas version
 * pair, no echo of the binding's writes back into the editor, and durable delete tombstones.
 */

function element(id: string, overrides?: Partial<CanvasElement>): CanvasElement {
  return {
    id,
    type: 'rectangle',
    version: 1,
    versionNonce: 100,
    x: 0,
    y: 0,
    index: `a${id}`,
    ...overrides,
  };
}

const docs: Y.Doc[] = [];
const bindings: CanvasBinding[] = [];

function bound(onRemote: (elements: CanvasElement[]) => void = () => undefined): {
  doc: Y.Doc;
  binding: CanvasBinding;
} {
  const doc = new Y.Doc();
  docs.push(doc);
  const binding = createCanvasBinding(doc, onRemote);
  bindings.push(binding);
  return { doc, binding };
}

/** Wires two documents the way the server does: every update reaches the other side. */
function link(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (update: Uint8Array) => {
    Y.applyUpdate(b, update, 'remote');
  });
  b.on('update', (update: Uint8Array) => {
    Y.applyUpdate(a, update, 'remote');
  });
}

afterEach(() => {
  for (const binding of bindings.splice(0)) {
    binding.destroy();
  }
  for (const doc of docs.splice(0)) {
    doc.destroy();
  }
});

describe('the canvas binding', () => {
  it('does not echo its own writes back into the editor', () => {
    const remoteCalls: CanvasElement[][] = [];
    const { binding } = bound((elements) => {
      remoteCalls.push(elements);
    });

    binding.applyLocal([element('a')]);

    expect(remoteCalls).toEqual([]);
    expect(binding.snapshot().map((each) => each.id)).toEqual(['a']);
  });

  it('isolates nested Excalidraw data from renderer mutation in both directions', () => {
    const { binding } = bound();
    const points: [number, number][] = [
      [0, 0],
      [20, 10],
    ];
    binding.applyLocal([element('line', { type: 'line', points })]);

    points[1] = [999, 999];
    const first = binding.snapshot();
    const firstPoints = first[0]?.points as [number, number][] | undefined;
    expect(firstPoints).toEqual([
      [0, 0],
      [20, 10],
    ]);

    if (firstPoints !== undefined) firstPoints[0] = [777, 777];
    const secondPoints = binding.snapshot()[0]?.points;
    expect(secondPoints).toEqual([
      [0, 0],
      [20, 10],
    ]);
  });

  it('reports a remote change with the full merged scene', () => {
    const remoteCalls: CanvasElement[][] = [];
    const { doc, binding } = bound((elements) => {
      remoteCalls.push(elements);
    });
    binding.applyLocal([element('mine')]);

    const other = new Y.Doc();
    docs.push(other);
    other.getMap<CanvasElement>('elements').set('theirs', element('theirs'));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), 'remote');

    expect(remoteCalls.length).toBe(1);
    expect(remoteCalls[0]?.map((each) => each.id).sort()).toEqual(['mine', 'theirs']);
  });

  it('lets the higher version win a concurrent move, on both sides identically', () => {
    const a = bound();
    const b = bound();
    link(a.doc, b.doc);

    a.binding.applyLocal([element('shape', { version: 3, x: 10 })]);
    b.binding.applyLocal([element('shape', { version: 5, x: 99 })]);

    expect(a.binding.snapshot()[0]).toMatchObject({ x: 99, version: 5 });
    expect(b.binding.snapshot()[0]).toMatchObject({ x: 99, version: 5 });
  });

  it('breaks a version tie by the lower nonce, deterministically', () => {
    expect(supersedes(element('e', { versionNonce: 5 }), element('e', { versionNonce: 9 }))).toBe(
      true,
    );
    expect(supersedes(element('e', { versionNonce: 9 }), element('e', { versionNonce: 5 }))).toBe(
      false,
    );
  });

  it('never lets a stale write clobber a newer element', () => {
    const { binding } = bound();
    binding.applyLocal([element('shape', { version: 7, x: 50 })]);

    binding.applyLocal([element('shape', { version: 2, x: 1 })]);

    expect(binding.snapshot()[0]).toMatchObject({ version: 7, x: 50 });
  });

  it('keeps a delete as a tombstone that beats a concurrent older move', () => {
    const a = bound();
    const b = bound();
    link(a.doc, b.doc);
    a.binding.applyLocal([element('shape', { version: 2 })]);

    // The delete bumps the version so it supersedes the
    // move that happened against the older version.
    b.binding.applyLocal([element('shape', { version: 4, isDeleted: true })]);
    a.binding.applyLocal([element('shape', { version: 3, x: 42 })]);

    expect(a.binding.snapshot()[0]).toMatchObject({ isDeleted: true, version: 4 });
    expect(b.binding.snapshot()[0]).toMatchObject({ isDeleted: true, version: 4 });
  });

  it('returns the scene in draw order, by fractional index', () => {
    const { binding } = bound();
    binding.applyLocal([
      element('late', { index: 'a3' }),
      element('early', { index: 'a1' }),
      element('middle', { index: 'a2' }),
    ]);

    expect(binding.snapshot().map((each) => each.id)).toEqual(['early', 'middle', 'late']);
  });

  it('stops observing after destroy', () => {
    const remoteCalls: CanvasElement[][] = [];
    const { doc, binding } = bound((elements) => {
      remoteCalls.push(elements);
    });

    binding.destroy();
    doc.getMap<CanvasElement>('elements').set('after', element('after'));

    expect(remoteCalls).toEqual([]);
  });
});
