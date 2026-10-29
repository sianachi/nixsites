import { describe, expect, it } from 'vitest';

import { FIXTURE_DOCUMENT, VERSION_1_DOCUMENT } from './fixtures.js';
import { SCHEMA_VERSION, nixSchema, parseDocument } from './schema.js';
import {
  BASE_SCHEMA_VERSION,
  MARK_MIN_VERSION,
  NODE_MIN_VERSION,
  requiredSchemaVersion,
  type MinimumVersions,
} from './versions.js';

/**
 * What a document needs, as distinct from what this build speaks.
 *
 * These two facts are easy to conflate and the conflation is the bug the version tables exist
 * to prevent: `SCHEMA_VERSION` is a property of the code, `requiredSchemaVersion` is a property
 * of one document, and a stored pin is only honest while the second never exceeds it.
 *
 * **The rule is tested against injected tables, not the shipped ones.** Both shipped tables are
 * empty at version 1, so every assertion written against them would also pass for a function
 * that ignored its argument and returned 1 - which is exactly what it would be doing. The
 * tables are a parameter so the behaviour can be stated now rather than first exercised by the
 * bump that depends on it.
 */
describe('the schema version a document requires', () => {
  const tables: MinimumVersions = { nodes: { blockquote: 2, codeBlock: 4 }, marks: { strike: 3 } };

  function parse(json: unknown) {
    const parsed = parseDocument(json);
    if (!parsed.ok) {
      throw new Error(`The fixture does not parse: ${parsed.error}`);
    }
    return parsed.document;
  }

  it('is the base version for a document using nothing the tables name', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(BASE_SCHEMA_VERSION);
  });

  it('takes the version of a node that needs one', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [] }] }],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(2);
  });

  it('takes the highest, not the first or the last, when several nodes need one', () => {
    const document = parse({
      type: 'doc',
      content: [
        { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [] }] },
      ],
    });

    // 4 from the code block, not 2 from the blockquote that comes after it.
    expect(requiredSchemaVersion(document, tables)).toBe(4);
  });

  it('is raised by a mark as readily as by a node', () => {
    // A mark is easy to forget when walking a tree, because it hangs off a node rather than
    // being one - and a document whose only new thing is a mark is a document that would be
    // written into a pin too low for it.
    const document = parse({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', marks: [{ type: 'strike' }], text: 'struck' }],
        },
      ],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(3);
  });

  it('finds a node nested several levels down', () => {
    const document = parse({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [] },
                { type: 'blockquote', content: [{ type: 'paragraph', content: [] }] },
              ],
            },
          ],
        },
      ],
    });

    expect(requiredSchemaVersion(document, tables)).toBe(2);
  });

  it('considers the root node, which descendants never visits', () => {
    const document = parse({
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    });

    expect(requiredSchemaVersion(document, { nodes: { doc: 5 }, marks: {} })).toBe(5);
  });

  it('is the base version for a document written before the first bump', () => {
    // The claim the version-2 migration rests on: nothing written at version 1 needs anything
    // newer, so raising a pin is all that migration has to do.
    expect(requiredSchemaVersion(parse(VERSION_1_DOCUMENT))).toBe(BASE_SCHEMA_VERSION);
  });

  it('rises to what the shipped fixture actually uses', () => {
    expect(requiredSchemaVersion(parse(FIXTURE_DOCUMENT))).toBe(7);
  });

  it('requires version 3 for an image backed by a durable file item', () => {
    const document = parse({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: '', fileItemId: '11111111-1111-4111-8111-111111111111' } },
      ],
    });

    expect(requiredSchemaVersion(document)).toBe(3);
  });
});

describe('a captured Mermaid picture', () => {
  it('requires version 6 only once a code block carries one', () => {
    const block = (attrs: Record<string, unknown>) => {
      const parsed = parseDocument({
        type: 'doc',
        content: [{ type: 'codeBlock', attrs, content: [{ type: 'text', text: 'graph TD' }] }],
      });
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.document;
    };

    expect(requiredSchemaVersion(block({ language: 'mermaid' }))).toBe(BASE_SCHEMA_VERSION);
    expect(
      requiredSchemaVersion(
        block({ language: 'mermaid', renderFileId: 'f', renderSourceHash: 'a'.repeat(64) }),
      ),
    ).toBe(6);
  });

  it('is not copied through HTML', () => {
    const codeBlock = nixSchema.nodes.codeBlock;
    const node = codeBlock?.create({
      language: 'mermaid',
      renderFileId: 'file-item',
      renderSourceHash: 'source-hash',
    });
    if (codeBlock === undefined || node === undefined) throw new Error('No code block.');
    const dom = JSON.stringify(codeBlock.spec.toDOM?.(node));
    expect(dom).not.toContain('file-item');
    expect(dom).not.toContain('source-hash');
  });
});

describe('embed views and suggestions', () => {
  const need = (node: unknown) => {
    const parsed = parseDocument({ type: 'doc', content: [node] });
    if (!parsed.ok) throw new Error(parsed.error);
    return requiredSchemaVersion(parsed.document);
  };
  const by = { id: 's', authorId: 'a', createdAt: '2026-10-29T00:00:00.000Z' };

  it('require version 7 only once used', () => {
    const embed = { targetId: 't', presentation: 'embed' };
    expect(need({ type: 'itemBlock', attrs: embed })).toBe(4);
    expect(need({ type: 'itemBlock', attrs: { ...embed, view: 'v' } })).toBe(7);
    expect(need({ type: 'paragraph' })).toBe(BASE_SCHEMA_VERSION);
    expect(need({ type: 'paragraph', attrs: { suggestion: { ...by, op: 'insert' } } })).toBe(7);
    expect(
      need({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'suggestionDelete', attrs: by }] }],
      }),
    ).toBe(7);
  });
});

describe('the shipped minimum-version tables', () => {
  it('claim nothing above what this build speaks', () => {
    // A node given a minimum above SCHEMA_VERSION could be produced by this build and then
    // refused everywhere it tried to store it - a bump somebody started and did not finish.
    for (const table of [NODE_MIN_VERSION, MARK_MIN_VERSION]) {
      for (const [name, minimum] of Object.entries(table)) {
        expect(minimum, `${name} claims a minimum above SCHEMA_VERSION`).toBeLessThanOrEqual(
          SCHEMA_VERSION,
        );
      }
    }
  });

  it('claim nothing at or below the base version, which would be noise', () => {
    for (const table of [NODE_MIN_VERSION, MARK_MIN_VERSION]) {
      for (const [name, minimum] of Object.entries(table)) {
        expect(minimum, `${name} names a minimum it did not need to`).toBeGreaterThan(
          BASE_SCHEMA_VERSION,
        );
      }
    }
  });

  it('name only nodes and marks the schema actually has', () => {
    // A stale entry is harmless at runtime and is a sign the table was edited without the
    // extension list, which is exactly the drift this package exists to prevent.
    for (const name of Object.keys(NODE_MIN_VERSION)) {
      expect(nixSchema.nodes[name], `${name} is not a node in the schema`).toBeDefined();
    }
    for (const name of Object.keys(MARK_MIN_VERSION)) {
      expect(nixSchema.marks[name], `${name} is not a mark in the schema`).toBeDefined();
    }
  });
});
