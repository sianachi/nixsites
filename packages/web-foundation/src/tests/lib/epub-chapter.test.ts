import { strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { buildEpubChapterDocument, EPUB_CHAPTER_POLICY } from '../../lib/epub-chapter';
import type { EpubBook } from '../../lib/epub-archive';
it('rebuilds hostile chapters with inert links, no active content and a network-denying policy', () => {
  const source =
    '<html><head><base href="https://attacker.invalid"><meta http-equiv="refresh" content="0;url=https://attacker.invalid"></head><body onload="alert(1)"><script>alert(1)</script><iframe src="https://attacker.invalid"></iframe><form action="https://attacker.invalid"><input></form><a href="https://example.com">link</a><a href="javascript:alert(1)">bad</a><img src="https://attacker.invalid/a" onerror="alert(1)"><p>Readable text</p></body></html>';
  const book: EpubBook = {
    title: null,
    author: null,
    spine: [{ path: 'chapter.xhtml' }],
    toc: [],
    readEntry: () => strToU8(source),
    hasEntry: () => true,
  };
  const html = buildEpubChapterDocument(book, 0, {
    fragment: null,
    fontScale: 100,
    palette: {
      background: 'Canvas',
      text: 'CanvasText',
      accent: 'LinkText',
      divider: 'GrayText',
      fontFamily: 'sans-serif',
      colorScheme: 'light',
    },
  });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  expect(doc.querySelector('script,iframe,form,base,input')).toBeNull();
  expect(doc.querySelector('meta')?.getAttribute('content')).toBe(EPUB_CHAPTER_POLICY);
  expect(doc.querySelector('[onload],[onerror],[href],[src]')).toBeNull();
  expect(doc.body.textContent).toContain('Readable text');
  expect(doc.body.textContent).toContain('https://example.com');
});
