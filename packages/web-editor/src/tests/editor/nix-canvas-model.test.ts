import { restoreElements } from '@excalidraw/excalidraw';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.hoisted(() => {
  if (typeof HTMLCanvasElement !== 'undefined') {
    HTMLCanvasElement.prototype.getContext =
      (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
});

import type { CanvasElement } from '../../editor/canvas-binding';
import { createCanvasBinding } from '../../editor/canvas-binding';
import {
  canvasFileItemIds,
  externalCanvasFiles,
  itemIdFromNixLink,
  nixFileItemIdFromElement,
  nixItemIdFromElement,
  nixItemLink,
  prepareCanvasElements,
  sceneFingerprint,
} from '../../editor/nix-canvas-model';

function element(overrides: Partial<CanvasElement> = {}): CanvasElement {
  return {
    id: 'shape-1',
    type: 'rectangle',
    version: 1,
    versionNonce: 7,
    index: 'a0',
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    ...overrides,
  };
}

describe('canvas scene compatibility', () => {
  it('persists repaired label ordering and converges after a shared-document round trip', () => {
    const doc = new Y.Doc();
    const binding = createCanvasBinding(doc, () => undefined);
    const container = element({ id: 'card', index: 'a9', version: 44 });
    const label = element({
      id: 'label',
      type: 'text',
      index: 'a3',
      version: 69,
      containerId: 'card',
      text: 'Item',
      originalText: 'Item',
    });
    binding.applyLocal([label, container]);

    const repaired = prepareCanvasElements(binding.snapshot());
    expect(repaired.map(({ id }) => id)).toEqual(['card', 'label']);
    expect(repaired.map(({ version }) => version)).toEqual([45, 70]);
    binding.applyLocal(repaired as unknown as CanvasElement[]);
    expect(binding.snapshot()).toEqual(repaired);
    expect(prepareCanvasElements(binding.snapshot())).toEqual(repaired);
    binding.destroy();
    doc.destroy();
  });

  it('sanitizes legacy order keys before Excalidraw restores the scene', () => {
    const [prepared] = prepareCanvasElements([
      element({
        index: 'z00003',
        strokeColor: '#123456', // design-token-exempt: complete fixture for real Excalidraw restoration.
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        angle: 0,
        seed: 1,
        groupIds: [],
      }),
    ]);

    if (prepared === undefined) throw new Error('Expected a prepared element.');
    expect(prepared.index).toBe('a0000000011');
    expect(() => restoreElements([prepared], null, { repairBindings: true })).not.toThrow();
  });

  it('leaves existing Excalidraw records intact', () => {
    const existing = element({
      type: 'diamond',
      customData: { retained: true },
      strokeColor: '#123456', // design-token-exempt: fixture proves an authored Excalidraw colour is not migrated.
      backgroundColor: '#abcdef', // design-token-exempt: fixture proves an authored Excalidraw colour is not migrated.
      fillStyle: 'cross-hatch',
      strokeWidth: 4,
      strokeStyle: 'dashed',
      roughness: 2,
      opacity: 1,
      angle: 0,
      seed: 42,
      groupIds: ['group-1'],
    });

    expect(prepareCanvasElements([existing])).toEqual([existing]);
    expect(prepareCanvasElements([existing])[0]).toBe(existing);
  });

  it('translates native appearance into the fields Excalidraw restores for overlapping types', () => {
    const native = element({
      type: 'rectangle',
      fill: 'surface',
      stroke: 'muted',
      opacity: 0.5,
      cornerRadius: 12,
    });

    const [prepared] = prepareCanvasElements([native]);

    expect(prepared).toMatchObject({
      id: 'shape-1',
      type: 'rectangle',
      strokeColor: '#5d5d60', // design-token-exempt: assertion pins the resolved durable migration value.
      backgroundColor: '#e9e9ea', // design-token-exempt: assertion pins the resolved durable migration value.
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 50,
      roundness: { type: 3 },
    });
  });

  it('keeps native style semantics authoritative after a native shape gained Excalidraw fields', () => {
    const openedByExcalidraw = element({
      fill: 'accent',
      stroke: 'foreground',
      cornerRadius: 12,
      strokeColor: '#000000', // design-token-exempt: fixture is the wrong intermediate serialized colour being repaired.
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 1,
      opacity: 1,
      angle: 0,
      seed: 42,
      groupIds: [],
    });

    expect(prepareCanvasElements([openedByExcalidraw])[0]).toMatchObject({
      strokeColor: '#1d1f20', // design-token-exempt: assertion pins the resolved durable migration value.
      backgroundColor: '#eef6ff', // design-token-exempt: assertion pins the resolved durable migration value.
      opacity: 100,
      roughness: 0,
      roundness: { type: 3 },
    });
  });

  it('makes every native shape fully visible when its old opacity is one', () => {
    const nativeTypes = [
      'rectangle',
      'ellipse',
      'line',
      'arrow',
      'text',
      'freehand',
      'card',
      'image',
    ];
    const prepared = prepareCanvasElements(
      nativeTypes.map((type, index) =>
        element({
          id: `native-${type}`,
          type,
          opacity: 1,
          fill: type === 'rectangle' || type === 'ellipse' || type === 'card' ? 'accent' : 'none',
          stroke: 'foreground',
          ...(type === 'freehand'
            ? {
                points: [
                  { x: 10, y: 20 },
                  { x: 15, y: 25 },
                ],
              }
            : {}),
          index: `a${String(index)}`,
        }),
      ),
    );

    expect(prepared).toHaveLength(nativeTypes.length + 1);
    expect(prepared.every((shape) => shape.opacity === 100)).toBe(true);
  });

  it('migrates native freehand points to Excalidraw local tuples', () => {
    const [migrated] = prepareCanvasElements([
      element({
        id: 'ink-1',
        type: 'freehand',
        x: 10,
        y: 20,
        points: [
          { x: 10, y: 20 },
          { x: 18, y: 27 },
        ],
      }),
    ]);

    expect(migrated).toMatchObject({
      id: 'ink-1',
      type: 'freedraw',
      points: [
        [0, 0],
        [8, 7],
      ],
      simulatePressure: true,
    });
  });

  it('turns native cards into labelled, navigable Excalidraw item shapes', () => {
    const prepared = prepareCanvasElements([element({ type: 'card', itemId: 'item/with spaces' })]);
    const [migrated, label] = prepared;
    if (migrated === undefined || label === undefined) {
      throw new Error('Expected a migrated card and its label.');
    }

    expect(migrated).toMatchObject({
      type: 'rectangle',
      link: 'nix://item/item%2Fwith%20spaces',
      customData: { nix: { kind: 'item', itemId: 'item/with spaces' } },
      boundElements: [{ type: 'text', id: 'shape-1-nix-card-label' }],
    });
    expect(label).toMatchObject({
      id: 'shape-1-nix-card-label',
      type: 'text',
      text: 'Nix item\nitem/with spaces',
      originalText: 'Nix item\nitem/with spaces',
      containerId: 'shape-1',
      textAlign: 'center',
      verticalAlign: 'middle',
      link: null,
    });
    expect(nixItemIdFromElement(migrated)).toBe('item/with spaces');
    expect(nixItemIdFromElement(label)).toBeNull();
    expect(prepareCanvasElements(prepared as unknown as readonly CanvasElement[])).toEqual(
      prepared,
    );
  });

  it('preserves embedded legacy card copy and normalizes it into a visible label', () => {
    const [, label] = prepareCanvasElements([
      element({
        type: 'card',
        itemId: 'item-42',
        title: '  Quarterly   plan  ',
        summary: 'Next\nquarter',
      }),
    ]);

    expect(label).toMatchObject({
      type: 'text',
      text: 'Quarterly plan\nNext quarter',
      originalText: 'Quarterly plan\nNext quarter',
      containerId: 'shape-1',
    });
  });

  it('reuses an already-persisted card label instead of duplicating it', () => {
    const storedLabel = element({
      id: 'saved-label',
      type: 'text',
      index: 'a1',
      containerId: 'shape-1',
      text: 'Persisted title',
      originalText: 'Persisted title',
      fontSize: 20,
      fontFamily: 5,
      textAlign: 'center',
      verticalAlign: 'middle',
      autoResize: false,
      lineHeight: 1.25,
      strokeColor: '#1d1f20', // design-token-exempt: fixture represents the migrated durable label colour.
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      angle: 0,
      seed: 9,
      groupIds: [],
    });
    const prepared = prepareCanvasElements([
      element({
        type: 'card',
        itemId: 'item-42',
        boundElements: [{ type: 'text', id: storedLabel.id }],
      }),
      storedLabel,
    ]);

    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toMatchObject({
      boundElements: [{ type: 'text', id: 'saved-label' }],
    });
    expect(prepared[1]).toBe(storedLabel);
  });

  it('claims a deterministic suffix when a legacy card label ID is already used', () => {
    const collision = element({ id: 'shape-1-nix-card-label', type: 'ellipse' });
    const prepared = prepareCanvasElements([
      element({ type: 'card', itemId: 'item-42' }),
      collision,
    ]);

    expect(prepared[1]).toMatchObject({
      id: 'shape-1-nix-card-label-2',
      type: 'text',
      containerId: 'shape-1',
    });
    expect(
      prepareCanvasElements([element({ type: 'card', itemId: 'item-42' }), collision])[1]?.id,
    ).toBe('shape-1-nix-card-label-2');
  });

  it('maps durable image items to Excalidraw file IDs without bytes or capability URLs', () => {
    const fileId = '1706c2b6-9e7a-4e13-bc93-ffadcd1c70e7';
    const [migrated] = prepareCanvasElements([
      element({ type: 'image', imageItemId: fileId, imageUrl: '', alt: 'Plan' }),
    ]);
    if (migrated === undefined) throw new Error('Expected a migrated image.');

    expect(migrated).toMatchObject({ type: 'image', fileId, status: 'saved' });
    expect(nixFileItemIdFromElement(migrated)).toBe(fileId);
    expect(JSON.stringify(migrated)).not.toContain('data:image');
    expect(canvasFileItemIds([migrated])).toEqual([fileId]);
  });

  it('does not infer Nix ownership from an unmarked UUID-shaped Excalidraw file ID', () => {
    const opaqueFileId = '1706c2b6-9e7a-4e13-bc93-ffadcd1c70e7';
    const [migrated] = prepareCanvasElements([
      element({
        type: 'image',
        fileId: opaqueFileId,
        customData: { retained: true },
      }),
    ]);
    if (migrated === undefined) throw new Error('Expected an image element.');

    expect(migrated).toMatchObject({ fileId: opaqueFileId, customData: { retained: true } });
    expect(nixFileItemIdFromElement(migrated)).toBeNull();
    expect(canvasFileItemIds([migrated])).toEqual([]);
  });

  it('uses a canonical file marker when it disagrees with an opaque file ID', () => {
    const fileItemId = '1706c2b6-9e7a-4e13-bc93-ffadcd1c70e7';
    const [migrated] = prepareCanvasElements([
      element({
        type: 'image',
        fileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        customData: { nix: { kind: 'file', itemId: fileItemId, label: 'Plan' } },
      }),
    ]);
    if (migrated === undefined) throw new Error('Expected an image element.');

    expect(migrated).toMatchObject({
      fileId: fileItemId,
      customData: { nix: { kind: 'file', itemId: fileItemId, label: 'Plan' } },
    });
    expect(canvasFileItemIds([migrated])).toEqual([fileItemId]);
  });

  it('keeps a legacy URL image visible only through an in-memory file entry', () => {
    const [migrated] = prepareCanvasElements([
      element({
        id: 'legacy-image',
        type: 'image',
        imageUrl: 'https://images.example/plan.webp',
        alt: 'Plan',
      }),
    ]);
    if (migrated === undefined) throw new Error('Expected a migrated image.');
    const [file] = externalCanvasFiles([migrated]);

    expect(migrated).toMatchObject({
      fileId: 'nix-external-legacy-image',
      customData: {
        nix: {
          kind: 'external-image',
          address: 'https://images.example/plan.webp',
          alt: 'Plan',
        },
      },
    });
    expect(file).toMatchObject({
      id: 'nix-external-legacy-image',
      dataURL: 'https://images.example/plan.webp',
      mimeType: 'image/webp',
    });
  });

  it('does not hand an unsafe legacy image address to Excalidraw', () => {
    const [migrated] = prepareCanvasElements([
      element({ type: 'image', imageUrl: 'data:image/svg+xml,<svg></svg>' }),
    ]);
    if (migrated === undefined) throw new Error('Expected an image element.');

    expect(migrated).toMatchObject({ fileId: null });
    expect(externalCanvasFiles([migrated])).toEqual([]);
  });

  it('fills the Excalidraw-specific fields of native lines and arrows', () => {
    const [line, arrow] = prepareCanvasElements([
      element({ type: 'line', width: -30, height: 15 }),
      element({ id: 'arrow-1', type: 'arrow', width: 40, height: 20 }),
    ]);

    expect(line).toMatchObject({
      points: [
        [0, 0],
        [-30, 15],
      ],
      startBinding: null,
      endBinding: null,
    });
    expect(arrow).toMatchObject({ endArrowhead: 'arrow', elbowed: false });
  });

  it('makes an unknown legacy record visible instead of silently dropping it', () => {
    expect(prepareCanvasElements([element({ type: 'future-widget' })])[0]).toMatchObject({
      type: 'rectangle',
      customData: { nix: { legacyType: 'future-widget' } },
    });
  });

  it('fingerprints reconciliation fields and preserves item-link round trips', () => {
    const shapes = [element(), element({ id: 'gone', version: 4, isDeleted: true, index: 'z9' })];
    expect(sceneFingerprint(shapes)).toBe('shape-1:1:7:0:a0|gone:4:7:1:z9');

    const link = nixItemLink('abc/123');
    expect(itemIdFromNixLink(link)).toBe('abc/123');
    expect(itemIdFromNixLink('https://example.com')).toBeNull();
    expect(itemIdFromNixLink('nix://item/%E0%A4%A')).toBeNull();
  });
});
