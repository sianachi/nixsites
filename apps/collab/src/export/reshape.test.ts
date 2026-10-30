import { describe, expect, it } from 'vitest';

import { readShape, reshape } from './assemble.ts';

const prose = {
  schemaVersion: 7,
  prosemirror: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Due', marks: [{ type: 'comment', attrs: { id: 'c1' } }] }],
      },
    ],
  },
};

describe('the shape a bundle body leaves in', () => {
  it('reads only the three shapes', () => {
    expect(readShape('render')).toBe('render');
    expect(readShape('tree')).toBeNull();
  });

  it('keeps a body as itself by default, and a sheet whatever the shape', () => {
    expect(reshape('item', prose, 'body')).toEqual({ body: prose });
    const sheet = { schemaVersion: 1, sheet: {} };
    expect(reshape('item', sheet, 'render')).toEqual({ body: sheet });
    expect(reshape('item', null, 'render')).toEqual({ body: null });
  });

  it('reshapes a prose body to a render tree with its losses, and no ProseMirror', () => {
    const out = reshape('item', prose, 'render');
    expect(out.body).toBeNull();
    expect(out.render).toMatchObject({
      format: 'nix-render',
      version: 1,
      blocks: [
        { kind: 'heading', level: 2, runs: [{ text: 'Plan' }] },
        { kind: 'paragraph', runs: [{ text: 'Due' }] },
      ],
    });
    expect(out.bodyLosses).toEqual(['Comments are not carried into exported documents.']);
    expect(out.render?.losses).toEqual(out.bodyLosses);
  });
});
