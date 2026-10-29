import { describe, expect, it } from 'vitest';
import { nixSchema, FIXTURE_DOCUMENT } from '@nix/editor-schema';
import { documentToMarkdown } from './to-markdown.js';
import { markdownToDocument } from './from-markdown.js';
import { MARKDOWN_LOSSES } from './losses.js';

/** A document wrapper around one or more block nodes. */
function doc(...content: unknown[]): unknown {
  return { type: 'doc', content };
}

function paragraph(...content: unknown[]): unknown {
  return { type: 'paragraph', content };
}

function text(value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): unknown {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

/** Canonicalise a document through the schema, so a comparison is over meaning, not over which
 *  default attributes each side happened to spell out. */
function canonical(json: unknown): unknown {
  return nixSchema.nodeFromJSON(json).toJSON();
}

/** Round-trip a document body through Markdown and back, returning the parsed result. */
function roundTrip(body: unknown): ReturnType<typeof markdownToDocument> {
  return markdownToDocument(documentToMarkdown(body).markdown);
}

describe('documentToMarkdown then markdownToDocument', () => {
  it('round-trips the schema fixture document into a valid body', () => {
    const result = roundTrip(FIXTURE_DOCUMENT);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a heading', doc({ type: 'heading', attrs: { level: 2 }, content: [text('A heading')] })],
    ['a paragraph', doc(paragraph(text('Plain prose.')))],
    ['a blockquote', doc({ type: 'blockquote', content: [paragraph(text('Quoted.'))] })],
    [
      'a horizontal rule',
      doc(paragraph(text('Above.')), { type: 'horizontalRule' }, paragraph(text('Below.'))),
    ],
    [
      'a fenced code block',
      doc({
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [text('const answer = 42;')],
      }),
    ],
    [
      'a bullet list',
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph(text('One'))] },
          { type: 'listItem', content: [paragraph(text('Two'))] },
        ],
      }),
    ],
    [
      'an image',
      doc({ type: 'image', attrs: { src: 'https://example.test/d.png', alt: 'A diagram' } }),
    ],
  ])('round-trips %s unchanged', (_label, body) => {
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips the inline marks Markdown carries', () => {
    const body = doc(
      paragraph(
        text('bold', [{ type: 'bold' }]),
        text(' '),
        text('italic', [{ type: 'italic' }]),
        text(' '),
        text('struck', [{ type: 'strike' }]),
        text(' '),
        text('code', [{ type: 'code' }]),
      ),
    );
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips table structure, cell roles, and column alignment', () => {
    const cellAttrs = (align: 'left' | 'right') => ({
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      align,
    });
    const body = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: cellAttrs('left'),
              content: [paragraph(text('Name'))],
            },
            {
              type: 'tableHeader',
              attrs: cellAttrs('right'),
              content: [paragraph(text('Count'))],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: cellAttrs('left'),
              content: [paragraph(text('Nix'))],
            },
            {
              type: 'tableCell',
              attrs: cellAttrs('right'),
              content: [paragraph(text('42'))],
            },
          ],
        },
      ],
    });

    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips a callout through its admonition spelling', () => {
    const body = doc({
      type: 'callout',
      attrs: { tone: 'warning' },
      content: [paragraph(text('Mind the gap.'))],
    });
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });

  it('round-trips a reference through its nix link', () => {
    const body = doc(
      paragraph(text('See '), {
        type: 'reference',
        attrs: {
          kind: 'item',
          targetId: '0199c0de-0000-7000-8000-000000000001',
          label: 'The other note',
        },
      }),
    );
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(canonical(result.doc)).toEqual(canonical(body));
    }
  });
});

describe('documentToMarkdown emits the documented spellings', () => {
  it('writes a callout as a tone admonition blockquote', () => {
    const { markdown } = documentToMarkdown(
      doc({ type: 'callout', attrs: { tone: 'warning' }, content: [paragraph(text('Careful.'))] }),
    );
    expect(markdown).toContain('> [!warning]');
    expect(markdown).toContain('Careful.');
  });

  it('writes a reference as a nix item link', () => {
    const { markdown } = documentToMarkdown(
      doc(
        paragraph({
          type: 'reference',
          attrs: { kind: 'item', targetId: 'abc', label: 'Note' },
        }),
      ),
    );
    expect(markdown).toContain('[Note](nix://item/abc)');
  });

  it('writes a details block as HTML', () => {
    const { markdown } = documentToMarkdown(
      doc({
        type: 'details',
        attrs: { toggleLevel: 2 },
        content: [
          { type: 'detailsSummary', content: [text('Show the details')] },
          { type: 'detailsContent', content: [paragraph(text('Here they are.'))] },
        ],
      }),
    );
    expect(markdown).toContain('<details');
    expect(markdown).toContain('<summary>Show the details</summary>');
  });
});

describe('declared losses', () => {
  it('reports a flattened column layout and keeps the text', () => {
    const body = doc({
      type: 'columnBlock',
      content: [
        { type: 'column', attrs: { width: 2 }, content: [paragraph(text('Left.'))] },
        { type: 'column', attrs: { width: null }, content: [paragraph(text('Right.'))] },
      ],
    });
    const { markdown, losses } = documentToMarkdown(body);
    expect(losses.map((loss) => loss.kind)).toContain(MARKDOWN_LOSSES.columnsFlattened.kind);
    expect(markdown).toContain('Left.');
    expect(markdown).toContain('Right.');
    // The flattened form still parses into a valid body, it is simply no longer two columns.
    expect(roundTrip(body).ok).toBe(true);
  });

  it('degrades a details block to readable content that still validates', () => {
    const body = doc({
      type: 'details',
      attrs: { toggleLevel: null },
      content: [
        { type: 'detailsSummary', content: [text('Summary')] },
        { type: 'detailsContent', content: [paragraph(text('Body text.'))] },
      ],
    });
    const result = roundTrip(body);
    expect(result.ok).toBe(true);
    expect(documentToMarkdown(result.ok ? result.doc : body).markdown).toContain('Body text.');
  });

  it('reports the header, merged-cell, width, block and mark losses of a rich table', () => {
    const attrs = (overrides: Record<string, unknown> = {}) => ({
      colspan: 1,
      rowspan: 1,
      colwidth: null,
      align: null,
      ...overrides,
    });
    const body = doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: attrs({ colspan: 2, colwidth: [160, 240] }),
              content: [
                paragraph(
                  text('Rich', [{ type: 'bold' }]),
                  text(' and '),
                  text('linked', [{ type: 'link', attrs: { href: 'https://example.test/table' } }]),
                ),
                paragraph(text('Second block')),
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', attrs: attrs(), content: [paragraph(text('Left'))] },
            { type: 'tableCell', attrs: attrs(), content: [paragraph(text('Right'))] },
          ],
        },
      ],
    });

    const { markdown, losses } = documentToMarkdown(body);
    expect(losses).toContainEqual(MARKDOWN_LOSSES.tableFlattened);
    expect(markdown).toContain('Rich and linkedSecond block');
    expect(markdown).not.toContain('**Rich**');
    expect(markdown).not.toContain('https://example.test/table');

    const imported = markdownToDocument(markdown);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      const firstRow = firstNodeOfType(imported.doc, 'table')?.content?.[0];
      expect(firstRow?.content?.map((cell) => cell.type)).toEqual(['tableHeader', 'tableHeader']);
      expect(firstRow?.content?.map((cell) => cell.attrs)).toEqual([
        { colspan: 1, rowspan: 1, colwidth: null, align: null },
        { colspan: 1, rowspan: 1, colwidth: null, align: null },
      ]);
    }
  });
});

describe('markdownToDocument', () => {
  it('parses standard Markdown into a valid body', () => {
    const result = markdownToDocument(
      '# Title\n\nA paragraph with **bold** and a [link](https://x.test).',
    );
    expect(result.ok).toBe(true);
  });

  it('imports a pipe table as editor table nodes with headers and alignment', () => {
    const result = markdownToDocument(
      'Before.\n\n| Name | Status |\n| :--- | ---: |\n| Nix | Ready |\n\nAfter.',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(blockTypes(result.doc)).toEqual(['paragraph', 'table', 'paragraph']);
      const table = firstNodeOfType(result.doc, 'table');
      expect(table?.content).toHaveLength(2);
      expect(table?.content?.[0]?.content?.map((cell) => cell.type)).toEqual([
        'tableHeader',
        'tableHeader',
      ]);
      expect(table?.content?.[1]?.content?.map((cell) => cell.type)).toEqual([
        'tableCell',
        'tableCell',
      ]);
      expect(table?.content?.[0]?.content?.map((cell) => cell.attrs?.align)).toEqual([
        'left',
        'right',
      ]);
      expect(allText(table)).toContain('Nix');
      expect(allText(table)).toContain('Ready');
    }
  });

  it('keeps inline formatting and links inside imported table cells', () => {
    const result = markdownToDocument(
      '| Project | Reference |\n| --- | --- |\n| **Nix** | [Plan](https://example.test/plan) |',
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const table = firstNodeOfType(result.doc, 'table');
      const bodyRow = table?.content?.[1];
      expect(bodyRow?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
      expect(bodyRow?.content?.[1]?.content?.[0]?.content?.[0]?.marks).toEqual([
        {
          type: 'link',
          attrs: {
            href: 'https://example.test/plan',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            class: null,
            title: null,
          },
        },
      ]);
    }
  });

  it('leaves pipe-shaped text inside a code fence as code', () => {
    const result = markdownToDocument('```text\n| not | a table |\n| --- | --- |\n```');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(blockTypes(result.doc)).toEqual(['codeBlock']);
      expect(firstNodeOfType(result.doc, 'table')).toBeUndefined();
      expect(allText(result.doc)).toContain('| not | a table |');
    }
  });

  it('keeps a standalone image as a block image node, with its neighbours intact', () => {
    const result = markdownToDocument('Above.\n\n![a drawing](https://x.test/a.png)\n\nBelow.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The neighbours matter as much as the image: the bug class this file guards is a block
      // silently vanishing, so a test that only finds the image could pass through that failure.
      expect(blockTypes(result.doc)).toEqual(['paragraph', 'image', 'paragraph']);
      expect(imageSrcs(result.doc)).toEqual(['https://x.test/a.png']);
      expect(allText(result.doc)).toContain('Above.');
      expect(allText(result.doc)).toContain('Below.');
    }
  });

  it('keeps an image with trailing blanks or a small indent on the block path, as CommonMark does', () => {
    const result = markdownToDocument(
      'A.\n\n![one](https://x.test/1.png) \n\n   ![two](https://x.test/2.png)\n\nB.',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual(['https://x.test/1.png', 'https://x.test/2.png']);
    }
  });

  it('degrades an inline image to a link, keeping the words around it', () => {
    // The regression this guards: the block image mapping made prosemirror-markdown drop the
    // whole enclosing block, silently - text destroyed with `losses: []`. Found live importing an
    // Obsidian-shaped note (2026-08-20).
    const result = markdownToDocument(
      '# Hello\n\nA [[Wiki Link]] and a local image ![pic](./img.png).\n',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Asserted on the parsed document, not the serializer: this is the inbound parser's test,
      // and it must not fail because the outbound direction changed.
      expect(allText(result.doc)).toContain('and a local image');
      expect(allText(result.doc)).toContain('Wiki Link');
      expect(linkHrefs(result.doc)).toContain('./img.png');
      expect(result.localImageTargets).toEqual(['./img.png']);
      expect(result.scan).toEqual({
        unresolvedWikiLinks: 1,
        unresolvedObsidianEmbeds: 0,
        unresolvedLocalImages: 1,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }
  });

  it('degrades a standalone local image to a link instead of a broken image node', () => {
    const result = markdownToDocument('![diagram](./assets/diagram.png "Architecture")');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual([]);
      expect(linkHrefs(result.doc)).toEqual(['./assets/diagram.png']);
      expect(allText(result.doc)).toContain('diagram');
      expect(result.scan.unresolvedLocalImages).toBe(1);
    }
  });

  it('preserves a titled reference-style local image address while declaring it once', () => {
    const result = markdownToDocument(
      'Before ![architecture][diagram] after.\n\n[diagram]: <./space image.png> "System map"',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual([]);
      expect(linkHrefs(result.doc)).toEqual(['./space%20image.png']);
      expect(linkTitles(result.doc)).toEqual(['System map']);
      expect(allText(result.doc)).toContain('Before architecture after.');
      expect(result.scan.unresolvedLocalImages).toBe(1);
    }
  });

  it('keeps neighbours when local images appear in rich block contexts', () => {
    const result = markdownToDocument(
      '# Heading ![one](./one.png) tail\n\n- Before ![two](./two.png) after\n\n> Around ![three](./three.png) text',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(allText(result.doc)).toContain('Heading one tail');
      expect(allText(result.doc)).toContain('Before two after');
      expect(allText(result.doc)).toContain('Around three text');
      expect(linkHrefs(result.doc)).toEqual(['./one.png', './two.png', './three.png']);
      expect(result.scan.unresolvedLocalImages).toBe(3);
    }
  });

  it('keeps empty, Windows, file, and unsupported image targets out of image nodes', () => {
    const result = markdownToDocument(
      [
        '![empty]()',
        '',
        '![windows](C:\\Pictures\\image.png)',
        '',
        '![file](file:///tmp/image.png)',
        '',
        '![nix](nix://item/image)',
        '',
        '![protocol](//example.test/image.png)',
        '',
        '![blob](blob:https://example.test/id)',
      ].join('\n'),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual([]);
      expect(allText(result.doc)).toContain('file:///tmp/image.png');
      expect(allText(result.doc)).toContain('C:%5CPictures%5Cimage.png');
      expect(allText(result.doc)).toContain('//example.test/image.png');
      expect(result.scan.unresolvedLocalImages).toBe(2);
      expect(result.scan.unsupportedImageAddresses).toBe(4);
    }
  });

  it('uses the address as the link text when an inline image has no alt', () => {
    const result = markdownToDocument('See ![](./shot.png) here.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(allText(result.doc)).toContain('./shot.png');
      expect(allText(result.doc)).toContain('here.');
      expect(linkHrefs(result.doc)).toContain('./shot.png');
    }
  });

  it('leaves image syntax inside fenced and inline code unchanged and uncounted', () => {
    const fenced = markdownToDocument(
      '```markdown\nUse ![alt](pic.png), [[Wiki]], and ![[Embed]] here.\n```',
    );
    expect(fenced.ok).toBe(true);
    if (fenced.ok) {
      expect(allText(fenced.doc)).toContain('Use ![alt](pic.png), [[Wiki]], and ![[Embed]] here.');
      expect(fenced.scan).toEqual({
        unresolvedWikiLinks: 0,
        unresolvedObsidianEmbeds: 0,
        unresolvedLocalImages: 0,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }

    const span = markdownToDocument('Write `![alt](pic.png) [[Wiki]] ![[Embed]]` to embed.');
    expect(span.ok).toBe(true);
    if (span.ok) {
      expect(allText(span.doc)).toContain('![alt](pic.png)');
      expect(span.scan).toEqual({
        unresolvedWikiLinks: 0,
        unresolvedObsidianEmbeds: 0,
        unresolvedLocalImages: 0,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }
  });

  it('reports wiki links and Obsidian embeds without overlap while keeping their source text', () => {
    const result = markdownToDocument(
      '[[Project]] ![[Pasted image 1.png|300]] ![[Note#Section]], \\[[literal wiki]], and \\![[literal embed]].',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(allText(result.doc)).toContain('[[Project]]');
      expect(allText(result.doc)).toContain('![[Pasted image 1.png|300]]');
      expect(allText(result.doc)).toContain('![[Note#Section]]');
      expect(imageSrcs(result.doc)).toEqual([]);
      expect(result.scan).toEqual({
        unresolvedWikiLinks: 1,
        unresolvedObsidianEmbeds: 2,
        unresolvedLocalImages: 0,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }
  });

  it('counts a wiki link nested in an ordinary Markdown link without stalling inline parsing', () => {
    const result = markdownToDocument('[outer [[Wiki]]](https://example.test)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(allText(result.doc)).toContain('outer [[Wiki]]');
      expect(linkHrefs(result.doc)).toEqual(['https://example.test']);
      expect(result.scan.unresolvedWikiLinks).toBe(1);
    }
  });

  it('reports an inline network image flattened to a link', () => {
    const result = markdownToDocument('Before ![plot](https://x.test/plot.png "Plot") after.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual([]);
      expect(linkHrefs(result.doc)).toEqual(['https://x.test/plot.png']);
      expect(allText(result.doc)).toContain('Before plot after.');
      expect(result.scan.inlineImagesFlattened).toBe(1);
    }
  });

  it('keeps a nested local image as readable source without creating a nested link', () => {
    const result = markdownToDocument('[![diagram](./local.png)](https://example.test/diagram)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(linkHrefs(result.doc)).toEqual(['https://example.test/diagram']);
      expect(allText(result.doc)).toContain('![diagram](./local.png)');
      expect(result.scan.unresolvedLocalImages).toBe(1);
    }
  });

  it('keeps the address when an inline image cannot safely become a link', () => {
    const result = markdownToDocument('Before ![pixel](data:image/png;base64,eA==) after.');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(linkHrefs(result.doc)).toEqual([]);
      expect(allText(result.doc)).toContain('![pixel](data:image/png;base64,eA==)');
      expect(result.scan.inlineImagesFlattened).toBe(1);
    }
  });

  it('preserves the existing standalone safe data-image mapping', () => {
    const result = markdownToDocument('![pixel](data:image/png;base64,eA==)');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(imageSrcs(result.doc)).toEqual(['data:image/png;base64,eA==']);
      expect(result.scan.unresolvedLocalImages).toBe(0);
      expect(result.scan.inlineImagesFlattened).toBe(0);
    }
  });

  it('does not reuse scan state between parser calls', () => {
    const first = markdownToDocument('[[One]] ![[Two]] ![local](./local.png)');
    const second = markdownToDocument('Plain text.');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      expect(first.scan).toEqual({
        unresolvedWikiLinks: 1,
        unresolvedObsidianEmbeds: 1,
        unresolvedLocalImages: 1,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }
    if (second.ok) {
      expect(second.scan).toEqual({
        unresolvedWikiLinks: 0,
        unresolvedObsidianEmbeds: 0,
        unresolvedLocalImages: 0,
        unsupportedImageAddresses: 0,
        inlineImagesFlattened: 0,
      });
    }
  });

  it('handles a large malformed bracket run without rescanning each suffix', () => {
    const source = '['.repeat(100_000);
    const result = markdownToDocument(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(allText(result.doc)).toHaveLength(source.length);
      expect(result.scan.unresolvedWikiLinks).toBe(0);
      expect(result.scan.unresolvedObsidianEmbeds).toBe(0);
    }
  });
});

interface LooseNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: LooseNode[];
}

function blockTypes(docJson: unknown): string[] {
  return ((docJson as LooseNode).content ?? []).map((node) => node.type ?? '');
}

function firstNodeOfType(docJson: unknown, type: string): LooseNode | undefined {
  let match: LooseNode | undefined;
  const walk = (node: LooseNode): void => {
    if (match !== undefined) {
      return;
    }
    if (node.type === type) {
      match = node;
      return;
    }
    for (const child of node.content ?? []) {
      walk(child);
    }
  };
  walk(docJson as LooseNode);
  return match;
}

function allText(docJson: unknown): string {
  const parts: string[] = [];
  const walk = (node: LooseNode): void => {
    if (typeof node.text === 'string') {
      parts.push(node.text);
    }
    for (const child of node.content ?? []) {
      walk(child);
    }
  };
  walk(docJson as LooseNode);
  return parts.join('');
}

function imageSrcs(docJson: unknown): string[] {
  const sources: string[] = [];
  const walk = (node: LooseNode): void => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      sources.push(node.attrs.src);
    }
    for (const child of node.content ?? []) {
      walk(child);
    }
  };
  walk(docJson as LooseNode);
  return sources;
}

function linkHrefs(docJson: unknown): string[] {
  const hrefs: string[] = [];
  const walk = (node: LooseNode): void => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
        hrefs.push(mark.attrs.href);
      }
    }
    for (const child of node.content ?? []) {
      walk(child);
    }
  };
  walk(docJson as LooseNode);
  return hrefs;
}

function linkTitles(docJson: unknown): (string | null)[] {
  const titles: (string | null)[] = [];
  const walk = (node: LooseNode): void => {
    for (const mark of node.marks ?? []) {
      if (mark.type === 'link') {
        titles.push(typeof mark.attrs?.title === 'string' ? mark.attrs.title : null);
      }
    }
    for (const child of node.content ?? []) {
      walk(child);
    }
  };
  walk(docJson as LooseNode);
  return titles;
}

it('exports block references as links and reports live-section and page-layout losses', () => {
  const result = documentToMarkdown(
    doc(
      {
        type: 'itemBlock',
        attrs: { targetId: '11111111-1111-4111-8111-111111111111', presentation: 'embed' },
      },
      { type: 'pageBreak' },
    ),
  );
  expect(result.markdown).toContain('nix://item/11111111-1111-4111-8111-111111111111');
  expect(result.losses.map((loss) => loss.kind)).toEqual(
    expect.arrayContaining(['item-block-linked', 'page-break-flattened']),
  );
});

it('reports poem alignment loss while keeping words and manual line breaks in Markdown', () => {
  const result = documentToMarkdown(
    doc({
      type: 'paragraph',
      attrs: { textAlign: 'center' },
      content: [text('One line'), { type: 'hardBreak' }, text('Next line')],
    }),
  );
  expect(result.markdown).toContain('One line');
  expect(result.markdown).toContain('Next line');
  expect(result.losses).toContainEqual(MARKDOWN_LOSSES.alignmentDropped);
});

it('writes a document with suggestions as if they were all rejected', () => {
  const mark = (type: string) => ({
    type,
    attrs: { id: 's1', authorId: 'a', createdAt: 'now' },
  });
  const result = documentToMarkdown(
    doc(
      paragraph(
        text('kept '),
        text('proposed', [mark('suggestionInsert')]),
        text('struck', [mark('suggestionDelete')]),
      ),
      {
        type: 'paragraph',
        attrs: { suggestion: { id: 's2', authorId: 'a', createdAt: 'now', op: 'insert' } },
        content: [text('new block', [mark('suggestionInsert')])],
      },
    ),
  );
  expect(result.markdown.trim()).toBe('kept struck');
  expect(result.losses).toEqual([]);
});
