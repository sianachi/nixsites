import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  parseEpub,
  resolveArchivePath,
  EpubRefusal,
  EPUB_MAX_ENTRY_BYTES,
} from '../../lib/epub-archive';
export function bookZip(
  chapter = '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><p>Chapter text</p></body></html>',
  extras: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>',
    ),
    'OEBPS/book.opf': strToU8(
      '<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>A book</dc:title></metadata><manifest><item id="one" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>',
    ),
    'OEBPS/chapter.xhtml': strToU8(chapter),
    ...extras,
  });
}
describe('EPUB archive boundary', () => {
  it('opens a chapter and its metadata', () => {
    const book = parseEpub(bookZip());
    expect(book.title).toBe('A book');
    expect(book.spine).toEqual([{ path: 'OEBPS/chapter.xhtml' }]);
    expect(book.readEntry('missing')).toBeNull();
  });
  it.each([
    '../../secret',
    'https://example.com/a',
    '//example.com/a',
    'javascript:alert(1)',
    'bad%',
    'a%00b',
  ])('refuses an outside or malformed reference %s', (reference) => {
    expect(resolveArchivePath('OEBPS/chapter.xhtml', reference)).toBeNull();
  });
  it('resolves an internal relative image', () => {
    expect(resolveArchivePath('OEBPS/text/chapter.xhtml', '../images/cover.png#x')).toBe(
      'OEBPS/images/cover.png',
    );
  });
  it('refuses DRM and a malformed archive', () => {
    expect(() =>
      parseEpub(
        bookZip(undefined, {
          'META-INF/encryption.xml': strToU8(
            '<encryption><EncryptionMethod Algorithm="drm"/></encryption>',
          ),
        }),
      ),
    ).toThrow(/DRM/);
    expect(() => parseEpub(new Uint8Array([1, 2, 3]))).toThrow(EpubRefusal);
  });
  it('refuses an archive whose directory understates the actual expanded data', () => {
    const bytes = bookZip();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 1, true);
        break;
      }
    }
    expect(() => parseEpub(bytes)).toThrow(EpubRefusal);
  });
  it('refuses oversized entries before inflating them', () => {
    const bytes = bookZip();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < bytes.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, EPUB_MAX_ENTRY_BYTES + 1, true);
        break;
      }
    }
    expect(() => parseEpub(bytes)).toThrow(/50 MB/);
  });
});
