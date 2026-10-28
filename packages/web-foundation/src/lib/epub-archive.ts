import { Unzip, UnzipInflate, unzipSync } from 'fflate';

/**
 * An EPUB, opened: its reading order, its table of contents, and a way to read one file from it.
 *
 * An EPUB is a ZIP of XHTML, CSS and images with a small XML index. Everything here is parsing and
 * bookkeeping - nothing is drawn and nothing touches the page - so the part that is hard to get
 * right (a hostile archive) is separate from the part that is hard to get pretty (the reader).
 *
 * **The book is untrusted.** Three things are refused before any chapter is read: an archive that
 * is not an EPUB, one that is encrypted (a reader that cannot decrypt would show noise and call it
 * a book), and one whose declared sizes say it is a decompression bomb. The sizes are the
 * archive's own claims, so they are checked from the directory before a byte is inflated, and an
 * entry is inflated into a buffer of exactly its declared size: an entry that lies about its size
 * is cut off at the claim rather than allowed to grow.
 */

/** More entries than this is a book nobody wrote by hand and an index nobody should build. */
export const EPUB_MAX_ENTRIES = 5_000;
/** One entry, uncompressed. A single image or chapter this large is not a book's. */
export const EPUB_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
/** Every entry, uncompressed, together. */
export const EPUB_MAX_TOTAL_BYTES = 300 * 1024 * 1024;

/** A reason the book cannot be opened, written for the person who chose the file. */
export class EpubRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpubRefusal';
  }
}

export interface EpubSpineItem {
  /** Where the chapter is in the archive. */
  readonly path: string;
}

export interface EpubTocEntry {
  readonly label: string;
  /** Nesting level, from zero. */
  readonly depth: number;
  /** The chapter this entry opens. */
  readonly spineIndex: number;
  /** The element within the chapter, when the entry names one. */
  readonly fragment: string | null;
}

export interface EpubBook {
  readonly title: string | null;
  readonly author: string | null;
  /** The reading order. May be empty: a package can declare no chapters. */
  readonly spine: readonly EpubSpineItem[];
  readonly toc: readonly EpubTocEntry[];
  /**
   * One file's bytes, or null when the archive has no such file or the file is over the entry
   * limit. The path is an archive path, as `resolveArchivePath` produces.
   */
  readonly readEntry: (path: string) => Uint8Array | null;
  readonly hasEntry: (path: string) => boolean;
}

const CONTAINER_PATH = 'META-INF/container.xml';
const ENCRYPTION_PATH = 'META-INF/encryption.xml';
const XHTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html']);

/**
 * The two font-obfuscation schemes. They scramble a font's first bytes so it cannot be lifted
 * from the book; they hide nothing a reader needs, and a book that uses them is not encrypted.
 */
const FONT_OBFUSCATION: ReadonlySet<string> = new Set([
  'http://www.idpf.org/2008/embedding',
  'http://ns.adobe.com/pdf/enc#RC',
]);

const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';

/**
 * A path inside the archive from a reference found in `fromPath`, or null when the reference
 * leaves the archive.
 *
 * Null covers every way out: a scheme (`http:`, `javascript:`, `data:`), a network-path
 * (`//host/x`), and `..` past the root. The archive root is the only thing a book can name.
 */
export function resolveArchivePath(fromPath: string, reference: string): string | null {
  const bare = reference.trim().split('#', 1)[0]?.split('?', 1)[0] ?? '';
  if (bare === '' || /^[a-z][a-z0-9+.-]*:/iu.test(bare) || bare.startsWith('//')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const base = decoded.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return null;
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return base.length === 0 ? null : base.join('/');
}

/** The part of a reference after the first `#`, decoded, or null. */
export function referenceFragment(reference: string): string | null {
  const index = reference.indexOf('#');
  if (index === -1 || index === reference.length - 1) return null;
  try {
    return decodeURIComponent(reference.slice(index + 1));
  } catch {
    return reference.slice(index + 1);
  }
}

function parseXml(text: string, what: string): Document {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new EpubRefusal(`This file is not a readable EPUB: its ${what} is malformed.`);
  }
  return document;
}

function parseNavigationDocument(text: string): Document {
  const xml = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  return xml.getElementsByTagName('parsererror').length === 0
    ? xml
    : new DOMParser().parseFromString(text, 'text/html');
}

function elementsNamed(parent: ParentNode, name: string): Element[] {
  return Array.from(parent.querySelectorAll('*')).filter((element) => element.localName === name);
}

function childrenNamed(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((element) => element.localName === name);
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

interface RawTocEntry {
  readonly label: string;
  readonly href: string;
  readonly depth: number;
}

/** The EPUB 3 navigation document's table of contents: nested ordered lists of links. */
function navigationEntries(document: Document): RawTocEntry[] {
  const navs = elementsNamed(document, 'nav');
  const toc =
    navs.find((nav) =>
      Array.from(nav.attributes).some(
        (attribute) =>
          attribute.localName === 'type' && attribute.value.split(/\s+/u).includes('toc'),
      ),
    ) ?? navs[0];
  if (toc === undefined) return [];

  const entries: RawTocEntry[] = [];
  const walk = (list: Element, depth: number): void => {
    for (const item of childrenNamed(list, 'li')) {
      const link = childrenNamed(item, 'a')[0];
      const heading = link ?? childrenNamed(item, 'span')[0];
      const href = link?.getAttribute('href');
      if (heading !== undefined && href !== null && href !== undefined) {
        entries.push({ label: cleanText(heading.textContent), href, depth });
      }
      for (const nested of childrenNamed(item, 'ol')) walk(nested, depth + 1);
    }
  };
  for (const list of childrenNamed(toc, 'ol')) walk(list, 0);
  return entries;
}

/** The EPUB 2 NCX table of contents: nested `navPoint`s. */
function ncxEntries(document: Document): RawTocEntry[] {
  const navMap = elementsNamed(document, 'navMap')[0];
  if (navMap === undefined) return [];

  const entries: RawTocEntry[] = [];
  const walk = (parent: Element, depth: number): void => {
    for (const point of childrenNamed(parent, 'navPoint')) {
      const label = cleanText(
        elementsNamed(childrenNamed(point, 'navLabel')[0] ?? point, 'text')[0]?.textContent,
      );
      const src = childrenNamed(point, 'content')[0]?.getAttribute('src');
      if (src !== null && src !== undefined) entries.push({ label, href: src, depth });
      walk(point, depth + 1);
    }
  };
  walk(navMap, 0);
  return entries;
}

export function parseEpub(bytes: Uint8Array): EpubBook {
  // Pass one reads the directory only: the filter says no to every entry, so nothing inflates
  // while the declared sizes are added up.
  const names = new Map<string, number>();
  let total = 0;
  let count = 0;
  try {
    unzipSync(bytes, {
      filter: (entry) => {
        count += 1;
        if (count > EPUB_MAX_ENTRIES) {
          throw new EpubRefusal(
            `This book has more than ${String(EPUB_MAX_ENTRIES)} files, which is more than the reader will open.`,
          );
        }
        if (entry.originalSize > EPUB_MAX_ENTRY_BYTES) {
          throw new EpubRefusal(
            'This book contains a file larger than 50 MB, which is more than the reader will open.',
          );
        }
        total += entry.originalSize;
        if (total > EPUB_MAX_TOTAL_BYTES) {
          throw new EpubRefusal(
            'This book is larger than 300 MB once unpacked, which is more than the reader will open.',
          );
        }
        if (names.has(entry.name))
          throw new EpubRefusal('This book contains duplicate file names.');
        names.set(entry.name, entry.originalSize);
        return false;
      },
    });
  } catch (reason) {
    if (reason instanceof EpubRefusal) throw reason;
    throw new EpubRefusal('This file is not an EPUB: it is not a readable ZIP archive.');
  }

  const decoder = new TextDecoder('utf-8');
  const readEntry = (path: string): Uint8Array | null => {
    const declared = names.get(path);
    if (declared === undefined || path.endsWith('/')) return null;
    try {
      const pieces: Uint8Array[] = [];
      let length = 0;
      const progress = { complete: false };
      let found = false;
      const archive = new Unzip((entry) => {
        if (entry.name !== path) return;
        if (found) throw new EpubRefusal('This book contains duplicate file names.');
        found = true;
        entry.ondata = (error, chunk, final) => {
          if (error) throw error;
          length += chunk.byteLength;
          // Do not trust directory sizes: stop inflating a lying archive at the actual bound.
          if (length > declared || length > EPUB_MAX_ENTRY_BYTES)
            throw new EpubRefusal('This book contains an invalid file size.');
          pieces.push(chunk);
          progress.complete = final;
        };
        entry.start();
      });
      archive.register(UnzipInflate);
      const step = 16 * 1024;
      for (let offset = 0; offset < bytes.length && !progress.complete; offset += step) {
        const end = Math.min(offset + step, bytes.length);
        archive.push(bytes.subarray(offset, end), end === bytes.length);
      }
      if (!progress.complete || length !== declared) return null;
      const result = new Uint8Array(length);
      let offset = 0;
      for (const piece of pieces) {
        result.set(piece, offset);
        offset += piece.byteLength;
      }
      return result;
    } catch {
      return null;
    }
  };
  const readText = (path: string): string | null => {
    const entry = readEntry(path);
    return entry === null ? null : decoder.decode(entry).replace(/^\uFEFF/u, '');
  };
  const hasEntry = (path: string): boolean => names.has(path) && !path.endsWith('/');

  const mimetype = readText('mimetype');
  if (names.has('mimetype') && mimetype?.trim() !== 'application/epub+zip') {
    throw new EpubRefusal('This file is a ZIP archive, but not an EPUB.');
  }

  const encryption = readText(ENCRYPTION_PATH);
  if (encryption !== null) {
    const methods = elementsNamed(parseXml(encryption, 'encryption manifest'), 'EncryptionMethod');
    const protectedContent =
      methods.length === 0 ||
      methods.some((method) => !FONT_OBFUSCATION.has(method.getAttribute('Algorithm') ?? ''));
    if (protectedContent) {
      throw new EpubRefusal(
        'This book is encrypted or protected by DRM, so it cannot be read here.',
      );
    }
  }

  const container = readText(CONTAINER_PATH);
  if (container === null) {
    throw new EpubRefusal('This file is a ZIP archive, but not an EPUB: it has no book index.');
  }
  const rootfile = elementsNamed(parseXml(container, 'book index'), 'rootfile')[0]?.getAttribute(
    'full-path',
  );
  const packagePath =
    rootfile === null || rootfile === undefined ? null : resolveArchivePath('x', rootfile);
  const packageText = packagePath === null ? null : readText(packagePath);
  if (packagePath === null || packageText === null) {
    throw new EpubRefusal('This EPUB is broken: its package file is missing.');
  }

  const opf = parseXml(packageText, 'package file');
  const metadata = elementsNamed(opf, 'metadata')[0];
  const dc = (name: string): string[] =>
    metadata === undefined
      ? []
      : Array.from(metadata.getElementsByTagNameNS(DC_NAMESPACE, name))
          .map((element) => cleanText(element.textContent))
          .filter((value) => value.length > 0);
  const title = dc('title')[0] ?? null;
  const authors = dc('creator');

  interface ManifestItem {
    readonly path: string;
    readonly mediaType: string;
    readonly properties: readonly string[];
  }
  const manifest = new Map<string, ManifestItem>();
  const manifestElement = elementsNamed(opf, 'manifest')[0];
  for (const item of manifestElement === undefined ? [] : childrenNamed(manifestElement, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    const path = href === null ? null : resolveArchivePath(packagePath, href);
    if (id === null || path === null) continue;
    manifest.set(id, {
      path,
      mediaType: (item.getAttribute('media-type') ?? '').toLowerCase(),
      properties: (item.getAttribute('properties') ?? '').split(/\s+/u),
    });
  }

  const spineElement = elementsNamed(opf, 'spine')[0];
  const spine: EpubSpineItem[] = [];
  for (const itemref of spineElement === undefined ? [] : childrenNamed(spineElement, 'itemref')) {
    const item = manifest.get(itemref.getAttribute('idref') ?? '');
    if (item === undefined || !hasEntry(item.path)) continue;
    const chapter =
      XHTML_MEDIA_TYPES.has(item.mediaType) ||
      (item.mediaType === '' && /\.(?:xhtml|html|htm)$/iu.test(item.path));
    if (chapter) spine.push({ path: item.path });
  }
  const spineIndexByPath = new Map(spine.map((item, index) => [item.path, index]));

  // EPUB 3 names a navigation document in the manifest; EPUB 2 points the spine at an NCX. A book
  // can carry both, and the navigation document is the newer and the better of the two.
  const navigation = [...manifest.values()].find((item) => item.properties.includes('nav'));
  const ncx =
    manifest.get(spineElement?.getAttribute('toc') ?? '') ??
    [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');
  let tocSource: { readonly path: string; readonly entries: RawTocEntry[] } | null = null;
  const navigationText = navigation === undefined ? null : readText(navigation.path);
  if (navigation !== undefined && navigationText !== null) {
    const entries = navigationEntries(parseNavigationDocument(navigationText));
    if (entries.length > 0) tocSource = { path: navigation.path, entries };
  }
  const ncxText = ncx === undefined ? null : readText(ncx.path);
  if (tocSource === null && ncx !== undefined && ncxText !== null) {
    const entries = ncxEntries(parseXml(ncxText, 'table of contents'));
    if (entries.length > 0) tocSource = { path: ncx.path, entries };
  }

  const toc: EpubTocEntry[] = [];
  for (const entry of tocSource?.entries ?? []) {
    const path = resolveArchivePath(tocSource?.path ?? '', entry.href);
    const spineIndex = path === null ? undefined : spineIndexByPath.get(path);
    if (spineIndex === undefined) continue;
    toc.push({
      label: entry.label === '' ? `Section ${String(toc.length + 1)}` : entry.label,
      depth: entry.depth,
      spineIndex,
      fragment: referenceFragment(entry.href),
    });
  }

  return {
    title,
    author: authors.length === 0 ? null : authors.join(', '),
    spine,
    toc,
    readEntry,
    hasEntry,
  };
}
