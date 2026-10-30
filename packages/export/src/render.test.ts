import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { FIXTURE_DOCUMENT, nixSchema } from '@nix/editor-schema';
import { describe, expect, it } from 'vitest';

import { createLossReport } from './loss.js';
import { documentFromRender, parseRenderDocument } from './render-from.js';
import { RENDER_VERSION, renderDocument, type RenderDocument } from './render.js';

/**
 * Shared with the Go worker's exporter and importer tests. `UPDATE_FIXTURES=1 vitest run` rewrites
 * it from the editor-schema fixture document, so the file is TypeScript-authored.
 */
const FIXTURE = new URL('../../../fixtures/nix-render-v1.json', import.meta.url);

function render(body: unknown): RenderDocument {
  const report = createLossReport();
  const tree = renderDocument(body, { itemId: 'item', report });
  if (tree === null) throw new Error('fixture body did not render');
  return tree;
}

describe('nix-render', () => {
  it('matches the shared fixture, which the Go worker reads', () => {
    const tree = render(FIXTURE_DOCUMENT);
    const expected = { prosemirror: FIXTURE_DOCUMENT, render: tree };
    if (process.env.UPDATE_FIXTURES === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(expected, null, 2)}\n`);
    }
    const stored = JSON.parse(readFileSync(FIXTURE, 'utf8')) as typeof expected;
    expect(stored).toEqual(expected);
    expect(tree.version).toBe(RENDER_VERSION);
  });

  it('draws every block kind the fixture document holds', () => {
    const kinds = new Set<string>();
    const walk = (blocks: RenderDocument['blocks']) => {
      for (const block of blocks) {
        kinds.add(block.kind);
        if ('blocks' in block) walk(block.blocks);
        if (block.kind === 'list')
          block.items.forEach((item) => {
            walk(item.blocks);
          });
      }
    };
    walk(render(FIXTURE_DOCUMENT).blocks);
    expect([...kinds].sort()).toEqual(
      [
        'callout',
        'code',
        'details',
        'heading',
        'image',
        'list',
        'pageBreak',
        'paragraph',
        'quote',
        'rule',
        'table',
      ].sort(),
    );
  });

  it('round-trips through the import mapper into a document the schema accepts', () => {
    const tree = render(FIXTURE_DOCUMENT);
    const doc = documentFromRender(tree);
    expect(() => {
      nixSchema.nodeFromJSON(doc).check();
    }).not.toThrow();
    const again = render(doc);
    expect(again.blocks).toEqual(tree.blocks);
  });

  it('keeps a nix-file image placeholder and link runs through the import mapper', () => {
    const tree = parseRenderDocument({
      format: 'nix-render',
      version: 1,
      blocks: [
        { kind: 'image', src: 'nix-file:asset-0001', alt: 'Floor plan' },
        {
          kind: 'paragraph',
          runs: [{ text: 'Plan', styles: ['bold'], href: 'https://example.test' }],
        },
        {
          kind: 'list',
          items: [{ checked: true, blocks: [{ kind: 'paragraph', runs: [{ text: 'done' }] }] }],
        },
      ],
    });
    if (tree === null) throw new Error('tree did not parse');
    const doc = documentFromRender(tree) as {
      content: Record<string, unknown>[];
    };
    expect(doc.content[0]).toMatchObject({ type: 'image', attrs: { src: 'nix-file:asset-0001' } });
    expect(doc.content[1]).toMatchObject({
      content: [
        {
          type: 'text',
          text: 'Plan',
          marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.test' } }],
        },
      ],
    });
    expect(doc.content[2]).toMatchObject({
      type: 'taskList',
      content: [{ type: 'taskItem', attrs: { checked: true } }],
    });
  });

  it('refuses another version or format', () => {
    expect(parseRenderDocument({ format: 'nix-render', version: 2, blocks: [] })).toBeNull();
    expect(parseRenderDocument({ format: 'markdown', version: 1, blocks: [] })).toBeNull();
  });
});
