import { describe, expect, it } from 'vitest';

import {
  MAX_SHARED_TEXT,
  parseLaunchIntent,
  sharedNoteDocument,
  sharedNoteTitle,
} from '../../launch/launch-intent';

function share(query: string) {
  const intent = parseLaunchIntent('share', new URLSearchParams(query));
  if (intent?.kind !== 'share') throw new Error('Not a share intent.');
  return intent;
}

describe('reading a launch', () => {
  it('knows the shortcut actions and nothing else', () => {
    for (const action of ['new', 'today', 'search', 'open'] as const) {
      expect(parseLaunchIntent(action, new URLSearchParams())).toEqual({ kind: action });
    }
    expect(parseLaunchIntent('delete-everything', new URLSearchParams())).toBeNull();
    expect(parseLaunchIntent(undefined, new URLSearchParams())).toBeNull();
  });

  it('ignores a share that carried nothing', () => {
    expect(parseLaunchIntent('share', new URLSearchParams())).toBeNull();
  });

  it('keeps only web links, dropping any other scheme a sharing app sends', () => {
    expect(share('url=https://example.com/a').url).toBe('https://example.com/a');
    expect(share('text=hi&url=javascript:alert(1)').url).toBeNull();
    expect(share('text=hi&url=file:///etc/passwd').url).toBeNull();
  });

  it('caps shared text rather than refusing it', () => {
    expect(share(`text=${'a'.repeat(MAX_SHARED_TEXT + 10)}`).text).toHaveLength(MAX_SHARED_TEXT);
  });

  it('titles a shared note by its title, else its first line, else its host', () => {
    expect(sharedNoteTitle(share('title=Plan&text=Body'))).toBe('Plan');
    expect(sharedNoteTitle(share('text=First line%0ASecond'))).toBe('First line');
    expect(sharedNoteTitle(share('url=https://example.com/a'))).toBe('example.com');
  });

  it('keeps shared text as plain paragraphs, never as Markdown that could load or disguise', () => {
    expect(
      sharedNoteDocument(
        share('text=![x](https://evil.example/p.gif)%0A[Sign in](https://evil.example)'),
      ),
    ).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '![x](https://evil.example/p.gif)' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: '[Sign in](https://evil.example)' }] },
      ],
    });
  });

  it('adds the link as itself, once, after the text', () => {
    expect(sharedNoteDocument(share('text=Read this&url=https://example.com/a'))).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Read this' }] },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'https://example.com/a',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/a' } }],
            },
          ],
        },
      ],
    });
    const repeated = sharedNoteDocument(
      share('text=Read https://example.com/a&url=https://example.com/a'),
    ) as { content: unknown[] };
    expect(repeated.content).toHaveLength(1);
  });
});
