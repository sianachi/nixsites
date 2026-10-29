import { describe, expect, it } from 'vitest';

import { prepareCanvasLibraryItems } from '../../editor/nix-canvas-library';

function element(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'shape-1',
    type: 'rectangle',
    version: 1,
    versionNonce: 7,
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    ...overrides,
  };
}

describe('canvas library compatibility', () => {
  it('keeps native Excalidraw v2 library items unchanged', () => {
    const item = {
      id: 'native-callout',
      status: 'published',
      created: 123,
      name: 'Callout',
      elements: [{ ...element(), isDeleted: false }],
    };

    const parsed = prepareCanvasLibraryItems([
      item,
      { ...item, id: '' },
      { ...item, status: 'unknown' },
    ]);

    expect(parsed).toEqual([item]);
    expect(parsed[0]).toBe(item);
  });

  it('migrates native Nix wrappers through the canvas element adapter', () => {
    const legacy = {
      type: 'nix-canvas-library-item',
      name: '  Planning shapes  ',
      document: JSON.stringify({
        version: 1,
        elements: [
          element({ futureProperty: { retained: true } }),
          element({
            id: 'ink-1',
            type: 'freehand',
            x: 10,
            y: 20,
            points: [
              { x: 10, y: 20 },
              { x: 14, y: 26 },
            ],
          }),
          element({ id: 'card-1', type: 'card', itemId: 'item-42' }),
          element({ id: 'deleted-1', isDeleted: true }),
        ],
      }),
    };

    const [migrated] = prepareCanvasLibraryItems([legacy]);
    const [again] = prepareCanvasLibraryItems([legacy]);

    expect(migrated).toMatchObject({
      status: 'unpublished',
      created: 1,
      name: 'Planning shapes',
    });
    expect(migrated?.id).toMatch(/^nix-native-v1-/u);
    expect(again?.id).toBe(migrated?.id);
    expect(migrated?.elements).toHaveLength(4);
    expect(migrated?.elements[0]).toMatchObject({
      id: 'shape-1',
      isDeleted: false,
      futureProperty: { retained: true },
    });
    expect(migrated?.elements[1]).toMatchObject({
      id: 'ink-1',
      type: 'freedraw',
      points: [
        [0, 0],
        [4, 6],
      ],
      isDeleted: false,
    });
    expect(migrated?.elements[2]).toMatchObject({
      id: 'card-1',
      type: 'rectangle',
      customData: { nix: { kind: 'item', itemId: 'item-42' } },
      boundElements: [{ type: 'text', id: 'card-1-nix-card-label' }],
      isDeleted: false,
    });
    expect(migrated?.elements[3]).toMatchObject({
      id: 'card-1-nix-card-label',
      type: 'text',
      text: 'Nix item\nitem-42',
      containerId: 'card-1',
      isDeleted: false,
    });
  });

  it('upgrades Excalidraw v1 array items with deterministic, collision-free IDs', () => {
    const oldItem = [element({ isDeleted: false })];

    const first = prepareCanvasLibraryItems([oldItem, oldItem]);
    const second = prepareCanvasLibraryItems([oldItem, oldItem]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]?.id).toMatch(/^nix-excalidraw-v1-/u);
    expect(first[1]?.id).toBe(`${String(first[0]?.id)}-2`);
  });

  it('omits malformed entries independently', () => {
    const valid = {
      type: 'nix-canvas-library-item',
      name: 'Valid',
      document: JSON.stringify({ version: 1, elements: [element()] }),
    };

    expect(
      prepareCanvasLibraryItems([
        { ...valid, document: '{' },
        { ...valid, document: JSON.stringify({ version: 2, elements: [element()] }) },
        {
          ...valid,
          document: JSON.stringify({
            version: 1,
            elements: [{ ...element(), versionNonce: 'bad' }],
          }),
        },
        { ...valid, document: JSON.stringify({ version: 1, elements: [] }) },
        valid,
      ]),
    ).toHaveLength(1);
  });
});
