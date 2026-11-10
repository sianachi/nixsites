import {
  LOSS_KINDS,
  type ArchiveManifest,
  type ConvertRequest,
  type ItemBundle,
} from '@nix/export';
import { describe, expect, it } from 'vitest';

import { markdownConverter } from './converter.js';

/**
 * The Markdown converter.
 *
 * Fed one prose bundle and its bytes read back as text, so the assertions are over the mapping the
 * converter decided rather than over a wrapper format: the item heading, the body, and the closing
 * section that repeats what was left out.
 */

/** A document wrapper around one or more block nodes. */
function doc(...content: unknown[]): unknown {
  return { type: 'doc', content };
}

function paragraph(...content: unknown[]): unknown {
  return { type: 'paragraph', content };
}

function text(value: string): unknown {
  return { type: 'text', text: value };
}

/** A side-by-side column block, which Markdown cannot carry and so records a loss. */
const COLUMNS_BODY = doc({
  type: 'columnBlock',
  content: [
    { type: 'column', attrs: { width: 2 }, content: [paragraph(text('Left side.'))] },
    { type: 'column', attrs: { width: null }, content: [paragraph(text('Right side.'))] },
  ],
});

function bundle(overrides: Partial<ItemBundle> = {}): ItemBundle {
  return {
    id: '0199c0de-0000-7000-8000-000000000001',
    parentId: null,
    workspaceId: '0199c0de-0000-7000-8000-000000000009',
    type: 'note',
    title: 'Quarterly Review',
    seq: '1000',
    lifecycleState: 'active',
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
    properties: {},
    schema: null,
    views: null,
    viewRows: [],
    viewRowsTruncated: false,
    body: { schemaVersion: 2, prosemirror: COLUMNS_BODY },
    ...overrides,
  };
}

async function* bundlesOf(...items: readonly ItemBundle[]): AsyncGenerator<ItemBundle> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

function requestFor(items: readonly ItemBundle[]): ConvertRequest {
  // The converter never reads the manifest, so a minimal one is enough for the fields it ignores.
  const manifest = {
    format: 'nix-archive',
    formatVersion: 1,
    schemaVersion: 2,
    exportedAt: '2026-08-13T00:00:00Z',
    root: '0199c0de-0000-7000-8000-000000000001',
    rootEffectiveSchema: null,
    includesDeleted: false,
    items: [],
    omitted: [],
    loss: [],
  } as unknown as ArchiveManifest;

  return {
    manifest,
    bundles: bundlesOf(...items),
    branding: {
      title: 'Quarterly Review',
      exportedAt: new Date('2026-08-13T00:00:00Z'),
      // The converter never reads the palette; a cast keeps the fixture to what it does read.
      palette: {} as unknown as ConvertRequest['branding']['palette'],
    },
  };
}

async function convert(...items: readonly ItemBundle[]): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of markdownConverter.convert(requestFor(items))) {
    chunks.push(chunk);
  }

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(joined);
}

describe('the Markdown converter', () => {
  it('retains readable children of unfamiliar editor blocks and reports the flattened presentation', async () => {
    const output = await convert(
      bundle({
        body: {
          schemaVersion: 99,
          prosemirror: doc({ type: 'futureBlock', content: [paragraph(text('Keep future text'))] }),
        },
      }),
    );
    expect(output).toContain('Keep future text');
    expect(output).toContain('flattened to readable content');
  });

  it('escapes active HTML in static source content', async () => {
    const output = await convert(
      bundle({ body: { schemaVersion: 1, sheet: { cells: { A1: '<script>alert(1)</script>' } } } }),
    );
    expect(output).not.toContain('<script>');
    expect(output).toContain('alert(1)');
  });

  it('bounds traversal through unfamiliar nested blocks', async () => {
    let nested: unknown = paragraph(text('Deep text'));
    for (let depth = 0; depth < 1000; depth++) nested = { type: 'futureBlock', content: [nested] };
    const output = await convert(bundle({ body: { schemaVersion: 99, prosemirror: doc(nested) } }));
    expect(output).toContain('nesting limit');
  });
  it.each([
    'list',
    'board',
    'calendar',
    'gallery',
    'timeline',
    'sheet',
    'form',
    'query',
    'interactive_form',
    'chart',
    'habit_tracker',
    'drive',
    'checklist',
    'outline',
    'matrix',
    'chat',
    'future_view',
  ])('exports %s with readable records and without reserved configuration', async (kind) => {
    const output = await convert(
      bundle({
        views: {
          default: 'review',
          views: [
            {
              id: 'review',
              name: 'Review',
              kind,
              columns: ['status'],
              groupBy: 'status',
              groupOrder: [],
              dateProperty: null,
              sortBy: null,
              sortDescending: false,
              mode: null,
              coverProperty: null,
              endDateProperty: null,
              cardSize: null,
            },
          ],
        },
        viewRows: [
          {
            id: 'task',
            title: 'Finish report',
            properties: {
              status: 'Open',
              chat_text: 'Saved reply',
              $chat_config: { secret: 'Do not show' },
            },
          },
        ],
        viewRowsTruncated: true,
      }),
    );
    expect(output).toContain(`Review (${kind.replaceAll('_', ' ')})`);
    expect(output).toContain('Finish report');
    expect(output).toContain('Saved reply');
    expect(output).toContain('incomplete');
    expect(output).not.toContain('Do not show');
  });

  it('keeps canvas text and spreadsheet cells and formulas', async () => {
    const output = await convert(
      bundle({
        body: {
          schemaVersion: 1,
          canvas: {
            elements: {
              text: { type: 'text', text: 'Launch plan', x: 10 },
              gone: { type: 'text', text: 'Deleted shape', isDeleted: true },
            },
          },
        },
      }),
      bundle({ body: { schemaVersion: 1, sheet: { cells: { A1: 'Budget', B2: '=SUM(B3:B8)' } } } }),
    );
    expect(output).toContain('Launch plan');
    expect(output).toContain('Budget');
    expect(output).toContain('=SUM(B3:B8)');
    expect(output).not.toContain('Deleted shape');
    expect(output).not.toContain('no text body');
  });

  it('keeps the last provided row beyond the old drawing ceiling', async () => {
    const output = await convert(
      bundle({
        viewRows: Array.from({ length: 100 }, (_, index) => ({
          id: String(index),
          title: `Task ${String(index)}`,
          properties: {},
        })),
        views: {
          default: 'review',
          views: [
            {
              id: 'review',
              name: 'Review',
              kind: 'list',
              columns: [],
              groupBy: null,
              groupOrder: [],
              dateProperty: null,
              sortBy: null,
              sortDescending: false,
              mode: null,
              coverProperty: null,
              endDateProperty: null,
              cardSize: null,
            },
          ],
        },
      }),
    );
    expect(output).toContain('Task 99');
  });
  it('writes the item title as a heading and the body beneath it', async () => {
    const output = await convert(bundle());

    expect(output).toContain('# Quarterly Review');
    expect(output).toContain('Left side.');
    expect(output).toContain('Right side.');
  });

  it('repeats what it left out in a closing section', async () => {
    const output = await convert(bundle());

    expect(output).toContain('## What was left out');
    // The column layout is the loss this body produces; the section names it.
    expect(output).toMatch(/single column/i);
  });

  it('declares a non-empty loss list, every kind of it a member of the closed set', () => {
    const declared = markdownConverter.declaredLoss();

    expect(declared.length).toBeGreaterThan(0);
    for (const notice of declared) {
      expect(LOSS_KINDS).toContain(notice.kind);
    }
  });
});
