import { describe, expect, it } from 'vitest';

import { FIXTURE_DOCUMENT, MARK_FIXTURES, NODE_FIXTURES, VERSION_1_DOCUMENT } from './fixtures.js';
import { MARK_MIN_VERSION, NODE_MIN_VERSION, requiredSchemaVersion } from './versions.js';
import { SCHEMA_VERSION, countNodes, emptyDocument, nixSchema, parseDocument } from './schema.js';

function documentOf(block: unknown): unknown {
  return { type: 'doc', content: [block] };
}

describe('the node set', () => {
  const expected = [
    'doc',
    'paragraph',
    'text',
    'hardBreak',
    'heading',
    'blockquote',
    'codeBlock',
    'horizontalRule',
    'callout',
    'image',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'table',
    'tableRow',
    'tableHeader',
    'tableCell',
  ];

  it.each(expected)('includes %s', (name) => {
    expect(nixSchema.nodes[name]).toBeDefined();
  });

  it('has no node the fixtures do not cover', () => {
    // The reverse direction, and the one that catches a block added without a fixture -
    // which is a block the collaboration service has never been asked to parse.
    const covered = new Set([
      'doc',
      'text',
      'listItem',
      'taskItem',
      'tableRow',
      'tableHeader',
      'tableCell',
      // Reachable only through their parent, like the list and table children above: a
      // column exists only inside a row, a summary and a body only inside a toggle.
      'column',
      'detailsSummary',
      'detailsContent',
      ...Object.keys(NODE_FIXTURES),
    ]);

    expect(Object.keys(nixSchema.nodes).filter((name) => !covered.has(name))).toEqual([]);
  });
});

describe('the mark set', () => {
  const expected = Object.keys(MARK_FIXTURES);

  it.each(expected)('includes %s', (name) => {
    expect(nixSchema.marks[name]).toBeDefined();
  });

  it('has no mark the fixtures do not cover', () => {
    expect(Object.keys(nixSchema.marks).sort()).toEqual(Object.keys(MARK_FIXTURES).sort());
  });
});

describe('round-tripping', () => {
  it.each(Object.entries(NODE_FIXTURES))(
    '%s survives a parse and a serialise',
    (_name, fixture) => {
      const parsed = parseDocument(documentOf(fixture));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // Serialising and reparsing has to reach the same JSON. An attribute the schema
      // silently drops shows up here and nowhere else.
      expect(parsed.document.toJSON()).toEqual(documentOf(fixture));
    },
  );

  it.each(Object.entries(MARK_FIXTURES))(
    '%s survives a parse and a serialise',
    (_name, fixture) => {
      const parsed = parseDocument(documentOf(fixture));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      expect(parsed.document.toJSON()).toEqual(documentOf(fixture));
    },
  );

  it('parses the document that uses every node and mark', () => {
    const parsed = parseDocument(FIXTURE_DOCUMENT);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(FIXTURE_DOCUMENT);
  });
});

describe('tables', () => {
  it('keeps a merged cell merged', () => {
    const merged = {
      type: 'table',
      attrs: { suggestion: null },
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 2, rowspan: 1, colwidth: null, align: null },
              content: [
                {
                  type: 'paragraph',
                  attrs: { textAlign: null, suggestion: null },
                  content: [{ type: 'text', text: 'Spans two' }],
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseDocument(documentOf(merged));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(documentOf(merged));
  });

  it('keeps a column width', () => {
    const sized = {
      type: 'table',
      attrs: { suggestion: null },
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { colspan: 1, rowspan: 1, colwidth: [180], align: null },
              content: [{ type: 'paragraph', attrs: { textAlign: null, suggestion: null } }],
            },
          ],
        },
      ],
    };

    const parsed = parseDocument(documentOf(sized));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.document.toJSON()).toEqual(documentOf(sized));
  });
});

describe('refusals', () => {
  it('refuses a node the schema does not define', () => {
    const parsed = parseDocument(documentOf({ type: 'spreadsheet' }));

    expect(parsed.ok).toBe(false);
  });

  it('refuses a mark the schema does not define', () => {
    const parsed = parseDocument(
      documentOf({
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [{ type: 'text', marks: [{ type: 'blink' }], text: 'no' }],
      }),
    );

    expect(parsed.ok).toBe(false);
  });

  it('refuses a block nested where the schema forbids it', () => {
    // A table row directly inside the document, with no table around it.
    const parsed = parseDocument(documentOf({ type: 'tableRow', content: [] }));

    expect(parsed.ok).toBe(false);
  });

  it('refuses something that is not a document at all', () => {
    expect(parseDocument(null).ok).toBe(false);
    expect(parseDocument('a string').ok).toBe(false);
  });
});

describe('callout tones', () => {
  it('accepts a tone this build does not know, and keeps it', () => {
    const parsed = parseDocument(
      documentOf({
        type: 'callout',
        attrs: { tone: 'interstellar' },
        content: [{ type: 'paragraph', attrs: { textAlign: null } }],
      }),
    );

    // Parsed, not refused: a callout whose colour this build cannot pick is readable, and
    // a document that will not open is not.
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Kept verbatim in the document rather than rewritten. An older build normalising the
    // value on load would destroy a newer build's tone the moment anybody opened the note
    // - a downgrade that silently edits documents is worse than one that renders them
    // plainly.
    expect(parsed.document.firstChild?.attrs.tone).toBe('interstellar');
  });

  it('renders an unknown tone as the default one', () => {
    // Where the fallback actually applies: on the way out. The colour comes from a token
    // named after the tone, and there is no token for a tone this build has never heard of.
    const parsed = parseDocument(
      documentOf({
        type: 'callout',
        attrs: { tone: 'interstellar' },
        content: [{ type: 'paragraph', attrs: { textAlign: null } }],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const callout = parsed.document.firstChild;
    if (callout === null) throw new Error('The fixture has no callout.');

    const rendered = JSON.stringify(nixSchema.nodes.callout?.spec.toDOM?.(callout));

    expect(rendered).toContain('"data-tone":"note"');
    expect(rendered).not.toContain('interstellar');
  });
});

describe('the empty document', () => {
  it('has one paragraph, so an editor has somewhere to put a cursor', () => {
    const document = emptyDocument();

    expect(document.childCount).toBe(1);
    expect(document.firstChild?.type.name).toBe('paragraph');
  });

  it('counts as two nodes', () => {
    expect(countNodes(emptyDocument())).toBe(2);
  });
});

describe('the schema version', () => {
  it('is pinned, because stored documents are validated against it', () => {
    // Changing this number is not a code change, it is a data migration: every stored
    // document carries a pin that has to be raised past it by a job at deploy (ADR-0024).
    // If this assertion fails, the question is whether that was done - not whether to
    // update the number.
    expect(SCHEMA_VERSION).toBe(7);
  });

  it('still opens a document written before the bump, unchanged', () => {
    // The claim the version-2 migration rests on. It raises pins and rewrites no content, so
    // it is only correct while every shape version 1 could produce still parses here.
    const parsed = parseDocument(VERSION_1_DOCUMENT);

    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  });

  it('needs nothing above version 1 to open such a document', () => {
    const parsed = parseDocument(VERSION_1_DOCUMENT);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    // Not merely parseable - genuinely a version-1 document. If this reported 2, the pin
    // check would refuse to write it back into the document it came out of.
    expect(requiredSchemaVersion(parsed.document)).toBe(1);
  });

  it('needs version 7 for the complete block, alignment, capture and suggestion fixture', () => {
    const parsed = parseDocument(FIXTURE_DOCUMENT);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    expect(requiredSchemaVersion(parsed.document)).toBe(7);
  });
});

describe('what version 2 added', () => {
  it('keeps a column out of the top level of a document', () => {
    // The entire guarantee of putting `column` in no group. A command-level check could be
    // forgotten; a content expression that has no way to admit the node cannot be.
    const column = nixSchema.nodes.column;
    if (column === undefined) {
      throw new Error('The schema has no column node.');
    }

    expect(nixSchema.topNodeType.contentMatch.matchType(column)).toBeNull();

    const parsed = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'column',
          content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [] }],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('accepts a row left with one column, and a column left empty', () => {
    // The merge argument in `columns.ts`, asserted rather than only stated. Two people editing
    // a row concurrently can arrive at either shape, and a schema that refused them would turn
    // a legal edit into a forced resync.
    const oneColumn = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'columnBlock',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [] }],
            },
          ],
        },
      ],
    });
    expect(oneColumn.ok, oneColumn.ok ? '' : oneColumn.error).toBe(true);

    const emptyColumn = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'columnBlock',
          content: [
            { type: 'column', content: [] },
            {
              type: 'column',
              content: [{ type: 'paragraph', attrs: { textAlign: null }, content: [] }],
            },
          ],
        },
      ],
    });
    expect(emptyColumn.ok, emptyColumn.ok ? '' : emptyColumn.error).toBe(true);
  });

  it('allows two comment threads to overlap', () => {
    // `excludes: ''`. Two people commenting on overlapping ranges is a normal thing for two
    // people to do, and a schema that refused it would silently drop one of them.
    const parsed = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            {
              type: 'text',
              marks: [
                { type: 'comment', attrs: { threadId: 'one' } },
                { type: 'comment', attrs: { threadId: 'two' } },
              ],
              text: 'discussed twice',
            },
          ],
        },
      ],
    });

    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  });

  it('opens a document carrying a colour it has never heard of', () => {
    // Forward compatibility, and the reason `readColor` falls back at render rather than at
    // parse: an older build must not silently rewrite a newer build's document just by opening
    // it. The value survives; only the drawing degrades.
    const parsed = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            {
              type: 'text',
              marks: [{ type: 'textColor', attrs: { text: 'chartreuse', background: null } }],
              text: 'from the future',
            },
          ],
        },
      ],
    });

    expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  });

  it('draws a reference as its stored label, not as an empty box', () => {
    const parsed = parseDocument({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            {
              type: 'reference',
              attrs: { kind: 'item', targetId: 'abc', label: 'The other note' },
            },
          ],
        },
      ],
    });
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    // Asked without a leaf-text argument, so the node's own `leafText` answers. Passing one
    // overrides it - which is exactly the bug this found in the collaboration service's search
    // materialisation, where every reference was contributing a space.
    expect(parsed.document.textBetween(0, parsed.document.content.size, ' ')).toContain(
      'The other note',
    );
  });
});

describe('the version-1 document', () => {
  it('exercises every node that existed at version 1', () => {
    // What stops this artefact rotting. It is the sole evidence that a pre-bump document still
    // parses, so a node it quietly stopped covering is a node nobody is checking.
    const parsed = parseDocument(VERSION_1_DOCUMENT);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const present = new Set<string>([parsed.document.type.name]);
    parsed.document.descendants((node) => {
      present.add(node.type.name);
      for (const mark of node.marks) {
        present.add(mark.type.name);
      }
      return true;
    });

    const versionOneNames = [
      ...Object.keys(nixSchema.nodes),
      ...Object.keys(nixSchema.marks),
    ].filter((name) => !addedAtVersion2(name));

    expect(versionOneNames.filter((name) => !present.has(name))).toEqual([]);
  });

  it('carries nothing version 2 added', () => {
    const parsed = parseDocument(VERSION_1_DOCUMENT);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }

    const newer: string[] = [];
    parsed.document.descendants((node) => {
      if (addedAtVersion2(node.type.name)) {
        newer.push(node.type.name);
      }
      for (const mark of node.marks) {
        if (addedAtVersion2(mark.type.name)) {
          newer.push(mark.type.name);
        }
      }
      return true;
    });

    expect(newer).toEqual([]);
  });
});

function addedAtVersion2(name: string): boolean {
  return NODE_MIN_VERSION[name] !== undefined || MARK_MIN_VERSION[name] !== undefined;
}

describe('explicit page boundaries', () => {
  it('accepts top-level page breaks but refuses boundaries inside tables and lists', () => {
    expect(
      parseDocument({
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { textAlign: null } },
          { type: 'pageBreak' },
          { type: 'paragraph', attrs: { textAlign: null } },
        ],
      }).ok,
    ).toBe(true);
    expect(
      parseDocument({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', attrs: { textAlign: null } }, { type: 'pageBreak' }],
              },
            ],
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
