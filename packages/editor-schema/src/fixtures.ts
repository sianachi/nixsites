import { SUGGESTIBLE_BLOCKS } from './suggestions.js';
import { MARK_MIN_VERSION, NODE_MIN_VERSION } from './versions.js';

/**
 * One fixture per node and per mark, plus a document that uses every one of them.
 *
 * These are the contract between the two sides of the schema. The collaboration service's
 * tests parse the same fixture document this package round-trips, so a change to the node
 * set that only one side heard about fails on both.
 *
 * Written as plain JSON rather than built through the schema on purpose: a fixture built
 * from the schema can only ever agree with it, which tests nothing. These are what a
 * client actually sends.
 */

const NODE_FIXTURES_SOURCE: Readonly<Record<string, unknown>> = {
  itemBlock: {
    type: 'itemBlock',
    attrs: { targetId: '00000000-0000-4000-8000-000000000001', presentation: 'embed' },
  },
  pageBreak: { type: 'pageBreak' },
  paragraph: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', text: 'A paragraph.' }],
  },

  heading: {
    type: 'heading',
    attrs: { level: 2, textAlign: null },
    content: [{ type: 'text', text: 'A heading' }],
  },

  hardBreak: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      { type: 'text', text: 'Before' },
      { type: 'hardBreak' },
      { type: 'text', text: 'after' },
    ],
  },

  blockquote: {
    type: 'blockquote',
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [{ type: 'text', text: 'Quoted.' }],
      },
    ],
  },

  codeBlock: {
    type: 'codeBlock',
    attrs: { language: 'typescript', renderFileId: null, renderSourceHash: null },
    content: [{ type: 'text', text: 'const answer = 42;' }],
  },

  horizontalRule: { type: 'horizontalRule' },

  bulletList: {
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'First' }],
          },
        ],
      },
      {
        // Nested, because a list that cannot nest is not the list anyone means.
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'Second' }],
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    attrs: { textAlign: null },
                    content: [{ type: 'text', text: 'Nested' }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  orderedList: {
    type: 'orderedList',
    attrs: { start: 1, type: null },
    content: [
      {
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'Step one' }],
          },
        ],
      },
    ],
  },

  taskList: {
    type: 'taskList',
    content: [
      {
        type: 'taskItem',
        attrs: { checked: true },
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'Done' }],
          },
        ],
      },
      {
        type: 'taskItem',
        attrs: { checked: false },
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'Not done' }],
          },
        ],
      },
    ],
  },

  callout: {
    type: 'callout',
    attrs: { tone: 'warning' },
    content: [
      {
        type: 'paragraph',
        attrs: { textAlign: null },
        content: [{ type: 'text', text: 'Mind the gap.' }],
      },
    ],
  },

  image: {
    type: 'image',
    attrs: {
      src: 'https://example.test/diagram.png',
      fileItemId: null,
      alt: 'A diagram',
      title: null,
      width: null,
      height: null,
    },
  },

  table: {
    type: 'table',
    content: [
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [
              {
                type: 'paragraph',
                attrs: { textAlign: null },
                content: [{ type: 'text', text: 'Name' }],
              },
            ],
          },
          {
            type: 'tableHeader',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [
              {
                type: 'paragraph',
                attrs: { textAlign: null },
                content: [{ type: 'text', text: 'Value' }],
              },
            ],
          },
        ],
      },
      {
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [
              {
                type: 'paragraph',
                attrs: { textAlign: null },
                content: [{ type: 'text', text: 'Answer' }],
              },
            ],
          },
          {
            type: 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null },
            content: [
              {
                type: 'paragraph',
                attrs: { textAlign: null },
                content: [{ type: 'text', text: '42' }],
              },
            ],
          },
        ],
      },
    ],
  },

  columnBlock: {
    type: 'columnBlock',
    content: [
      {
        type: 'column',
        attrs: { width: 2 },
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'The wider side.' }],
          },
        ],
      },
      {
        // No width: an equal share of what is left, which is what most columns want.
        type: 'column',
        attrs: { width: null },
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'The other side.' }],
          },
        ],
      },
    ],
  },

  details: {
    type: 'details',
    attrs: { toggleLevel: 2 },
    content: [
      {
        type: 'detailsSummary',
        attrs: { textAlign: null },
        content: [{ type: 'text', text: 'Show the details' }],
      },
      {
        type: 'detailsContent',
        content: [
          {
            type: 'paragraph',
            attrs: { textAlign: null },
            content: [{ type: 'text', text: 'Here they are.' }],
          },
        ],
      },
    ],
  },

  reference: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      { type: 'text', text: 'See ' },
      {
        type: 'reference',
        attrs: {
          kind: 'item',
          targetId: '0199c0de-0000-7000-8000-000000000001',
          label: 'The other note',
        },
      },
      { type: 'text', text: ' and ask ' },
      {
        type: 'reference',
        attrs: {
          kind: 'principal',
          targetId: '0199c0de-0000-7000-8000-000000000002',
          label: 'Ada',
        },
      },
    ],
  },
};

/** Version 7 defaults (`suggestion`, `itemBlock.view`), filled in so the sources above stay short. */
function withVersion7Defaults(fixture: unknown): unknown {
  if (Array.isArray(fixture)) return fixture.map(withVersion7Defaults);
  if (typeof fixture !== 'object' || fixture === null) return fixture;
  const node = Object.fromEntries(
    Object.entries(fixture).map(([key, value]) => [key, withVersion7Defaults(value)]),
  ) as { type?: unknown; attrs?: Record<string, unknown> };
  if (typeof node.type !== 'string') return node;
  const defaults: Record<string, unknown> = SUGGESTIBLE_BLOCKS.includes(node.type)
    ? { suggestion: null }
    : {};
  if (node.type === 'itemBlock') defaults.view = null;
  return Object.keys(defaults).length === 0
    ? node
    : { ...node, attrs: { ...defaults, ...node.attrs } };
}

/** A block-level fixture, keyed by the node it exercises. */
export const NODE_FIXTURES = withVersion7Defaults(NODE_FIXTURES_SOURCE) as Readonly<
  Record<string, unknown>
>;

/** An inline fixture per mark, each a paragraph carrying exactly that mark. */
/** A paragraph whose text carries one suggestion mark. */
function suggested(mark: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      {
        type: 'text',
        marks: [
          {
            type: mark,
            attrs: {
              id: 's-1',
              authorId: '0199c0de-0000-7000-8000-000000000004',
              createdAt: '2026-10-29T00:00:00.000Z',
              ...extra,
            },
          },
        ],
        text,
      },
    ],
  };
}

const MARK_FIXTURES_SOURCE: Readonly<Record<string, unknown>> = {
  bold: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'strong' }],
  },
  italic: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'italic' }], text: 'emphasis' }],
  },
  underline: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'underline' }], text: 'underlined' }],
  },
  strike: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'strike' }], text: 'struck' }],
  },
  code: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'code' }], text: 'inline()' }],
  },
  highlight: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [{ type: 'text', marks: [{ type: 'highlight' }], text: 'highlighted' }],
  },
  link: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      {
        type: 'text',
        marks: [
          {
            type: 'link',
            attrs: {
              href: 'https://example.test/page',
              target: '_blank',
              rel: 'noopener noreferrer nofollow',
              class: null,
              title: null,
            },
          },
        ],
        text: 'a link',
      },
    ],
  },
  textColor: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      {
        type: 'text',
        marks: [{ type: 'textColor', attrs: { text: 'danger', background: null } }],
        text: 'coloured by name',
      },
    ],
  },
  comment: {
    type: 'paragraph',
    attrs: { textAlign: null },
    content: [
      {
        type: 'text',
        marks: [{ type: 'comment', attrs: { threadId: '0199c0de-0000-7000-8000-000000000003' } }],
        text: 'somebody had a question about this',
      },
    ],
  },
  suggestionInsert: suggested('suggestionInsert', 'proposed'),
  suggestionDelete: suggested('suggestionDelete', 'struck'),
  suggestionFormat: suggested('suggestionFormat', 'restyled', { before: '[]' }),
};

export const MARK_FIXTURES = withVersion7Defaults(MARK_FIXTURES_SOURCE) as Readonly<
  Record<string, unknown>
>;

/**
 * One document using every node and every mark.
 *
 * The single artefact both sides check themselves against. If it parses here and in the
 * collaboration service, the two builds agree about what a document is.
 */
export const FIXTURE_DOCUMENT: unknown = withVersion7Defaults({
  type: 'doc',
  content: [
    ...Object.values(NODE_FIXTURES),
    ...Object.values(MARK_FIXTURES),
    {
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [{ type: 'text', text: 'A centered line.' }],
    },
    {
      // Version 6: a Mermaid block with its captured picture (ADR-0063).
      type: 'codeBlock',
      attrs: {
        language: 'mermaid',
        renderFileId: '22222222-2222-4222-8222-222222222222',
        renderSourceHash: 'c'.repeat(64),
      },
      content: [{ type: 'text', text: 'flowchart LR\n  A --> B' }],
    },
    {
      // Version 7: an embed that remembers its view, and a block inserted by a suggestion.
      type: 'itemBlock',
      attrs: {
        targetId: '00000000-0000-4000-8000-000000000001',
        presentation: 'embed',
        view: '0199c0de-0000-7000-8000-000000000005',
        suggestion: null,
      },
    },
    {
      type: 'paragraph',
      attrs: {
        textAlign: null,
        suggestion: {
          id: 's-2',
          authorId: '0199c0de-0000-7000-8000-000000000004',
          createdAt: '2026-10-29T00:00:00.000Z',
          op: 'insert',
        },
      },
      content: [{ type: 'text', text: 'A suggested paragraph.' }],
    },
  ],
});

/**
 * A document exactly as version 1 of the schema could produce it.
 *
 * **Every fixture that is not something version 2 added.** Its job is to be old: it is the
 * artefact that proves a document written before the bump still parses, unchanged, against the
 * schema that came after - which is the claim the migration rests on, because a pin-only
 * migration transforms no content and would be silently wrong if the old shapes had stopped
 * parsing.
 *
 * Selected against the version tables rather than copied by hand. A hand-trimmed copy was the
 * first attempt and it silently dropped `tableCell`, so the one node the artefact existed to
 * cover stopped being covered - the same rot the hard-coded style-coverage list had, one file
 * over. `schema.test.ts` asserts this document exercises every version-1 node, so the
 * selection cannot go quietly wrong either.
 */
function addedAfterVersion1(name: string): boolean {
  return NODE_MIN_VERSION[name] !== undefined || MARK_MIN_VERSION[name] !== undefined;
}

export const VERSION_1_DOCUMENT: unknown = {
  type: 'doc',
  content: [
    ...Object.entries(NODE_FIXTURES)
      .filter(([name]) => !addedAfterVersion1(name))
      .map(([, fixture]) => fixture),
    ...Object.entries(MARK_FIXTURES)
      .filter(([name]) => !addedAfterVersion1(name))
      .map(([, fixture]) => fixture),
  ],
};
