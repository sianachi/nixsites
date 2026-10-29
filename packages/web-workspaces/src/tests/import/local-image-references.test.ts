import { describe, expect, it } from 'vitest';

import { rewriteLocalImageReferences } from '../../import/local-image-references';

const SOURCE = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Architecture',
          marks: [
            { type: 'link', attrs: { href: './assets/architecture.png', title: 'System map' } },
          ],
        },
      ],
    },
  ],
};

describe('local Markdown image references', () => {
  it('replaces a selected standalone image fallback with its durable file item id', () => {
    const rewritten = rewriteLocalImageReferences(
      SOURCE,
      'vault/notes/overview.md',
      ['./assets/architecture.png'],
      new Map([['vault/notes/assets/architecture.png', '00000000-0000-4000-8000-000000000099']]),
    );

    expect(rewritten.resolved).toBe(1);
    expect(rewritten.doc).toEqual({
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: '',
            alt: 'Architecture',
            title: 'System map',
            fileItemId: '00000000-0000-4000-8000-000000000099',
          },
        },
      ],
    });
  });

  it('keeps the readable link when the referenced file was not selected', () => {
    const rewritten = rewriteLocalImageReferences(
      SOURCE,
      'vault/notes/overview.md',
      ['./assets/architecture.png'],
      new Map(),
    );

    expect(rewritten.resolved).toBe(0);
    expect(rewritten.doc).toEqual(SOURCE);
  });
});
