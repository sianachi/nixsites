import { resolveArchivePath, type EpubBook } from './epub-archive';

/**
 * One chapter of a book, made safe to show.
 *
 * **This is the security boundary of the reader, and it is three layers deep on purpose.** The
 * chapter is shown in an `<iframe sandbox="">` - no scripts, no same-origin, no forms, no popups,
 * no top navigation - so nothing in it can run or reach the application. Inside that, the
 * document carries a Content-Security-Policy that forbids every network request. And before any
 * of that, this file rebuilds the chapter so the dangerous parts are not in it: whatever one layer
 * misses, another has to miss as well.
 *
 * **What the chapter keeps.** Its text and structure, its stylesheets from inside the archive
 * (rewritten so every `url(...)` is either an image from the archive or nothing), and its images
 * from inside the archive, embedded as `data:` URLs. Not `blob:` URLs: a sandboxed frame has an
 * opaque origin, and the browser refuses it a blob made by the application's origin.
 *
 * **What it loses.** Scripts, frames, objects, forms, media, `<base>`, every `<meta>`, every event
 * handler attribute, fonts (the application's own policy admits only its own fonts, so an embedded
 * one could never load), `@import`, and every reference that is not inside the archive. A link to
 * the web becomes its text followed by its address, because a book must not be able to send a
 * reader anywhere or learn that it was opened.
 */

/** The policy written into every chapter. Anything it does not name is forbidden by `default-src`. */
export const EPUB_CHAPTER_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";

/** Images embedded in one chapter, together. A chapter past this keeps its text and loses the rest. */
export const EPUB_CHAPTER_IMAGE_BYTES = 40 * 1024 * 1024;

/** What a chapter needs to look like it belongs in the application. Plain colour strings. */
export interface EpubPalette {
  readonly background: string;
  readonly text: string;
  readonly accent: string;
  readonly divider: string;
  readonly fontFamily: string;
  readonly colorScheme: string;
}

export interface EpubChapterOptions {
  readonly palette: EpubPalette;
  /** The base font size as a percentage, 100 being the browser's default. */
  readonly fontScale: number;
  /** Start the chapter at this element, when the table of contents named one. */
  readonly fragment: string | null;
}

const SAFE_VALUE = /^[#a-zA-Z0-9(),.%\s'"-]+$/u;
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** Elements that never reach the chapter. `link` and `style` are handled apart, as stylesheets. */
const REMOVED_ELEMENTS: ReadonlySet<string> = new Set([
  'applet',
  'audio',
  'base',
  'embed',
  'form',
  'frame',
  'frameset',
  'iframe',
  'meta',
  'noscript',
  'object',
  'portal',
  'script',
  'source',
  'template',
  'track',
  'video',
]);

/** Attributes that name a resource. Kept only as an in-document `#reference`, or replaced. */
const REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'codebase',
  'data',
  'dynsrc',
  'formaction',
  'href',
  'icon',
  'imagesrcset',
  'longdesc',
  'lowsrc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcset',
  'usemap',
  'xlink:href',
]);

const INTERNAL_LINK_TITLE =
  'Links inside a book do not work in this reader. Use Contents or the chapter buttons.';

/**
 * The application's own colours, read from the page at the moment a chapter is drawn.
 *
 * A sandboxed frame inherits nothing, so the theme has to be written into it as plain values - and
 * read when the chapter is built, not at start-up, so a chapter drawn after a theme change has the
 * new ground. A value that does not look like a colour or a font stack is replaced by the
 * browser's own default rather than written into a stylesheet unchecked.
 */
export function readEpubPalette(root: Element): EpubPalette {
  const style = getComputedStyle(root);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value !== '' && SAFE_VALUE.test(value) ? value : fallback;
  };
  const scheme = style.colorScheme.trim();
  return {
    background: read('--color-bg', 'Canvas'),
    text: read('--color-text', 'CanvasText'),
    accent: read('--color-accent', 'LinkText'),
    divider: read('--color-divider', 'GrayText'),
    fontFamily: read('--font-body', 'system-ui, sans-serif'),
    colorScheme: /^(?:normal|light|dark|light dark|dark light)$/u.test(scheme) ? scheme : 'normal',
  };
}

function imageType(path: string): string | null {
  const extension = /\.([^./]+)$/u.exec(path)?.[1]?.toLowerCase();
  return extension === undefined ? null : (IMAGE_TYPES[extension] ?? null);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

type LinkKind = 'fragment' | 'archive' | 'external' | 'blocked';

function classifyLink(fromPath: string, reference: string): LinkKind {
  const value = reference.trim();
  if (value.startsWith('#')) return 'fragment';
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(value)?.[1]?.toLowerCase();
  if (scheme !== undefined) {
    return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel'
      ? 'external'
      : 'blocked';
  }
  if (value.startsWith('//')) return 'external';
  return resolveArchivePath(fromPath, value) === null ? 'blocked' : 'archive';
}

/** Turns an archive-relative image reference into a `data:` URL, or null when it cannot be one. */
class ImageEmbedder {
  private readonly cache = new Map<string, string | null>();
  private spent = 0;

  constructor(private readonly book: EpubBook) {}

  embed(fromPath: string, reference: string): string | null {
    const value = reference.trim();
    if (/^data:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp)[;,]/iu.test(value)) return value;
    const path = resolveArchivePath(fromPath, value);
    if (path === null) return null;
    if (this.cache.has(path)) return this.cache.get(path) ?? null;

    const type = imageType(path);
    const bytes = type === null ? null : this.book.readEntry(path);
    let result: string | null = null;
    if (type !== null && bytes !== null && this.spent + bytes.length <= EPUB_CHAPTER_IMAGE_BYTES) {
      this.spent += bytes.length;
      result = `data:${type};base64,${toBase64(bytes)}`;
    }
    this.cache.set(path, result);
    return result;
  }
}

/** A `url(...)` that points nowhere: valid wherever a url is, loads nothing. */
const EMPTY_URL = 'url("data:,")';

/**
 * Rewrites every `url(...)` in a piece of CSS: an image from the archive becomes its data URL, an
 * in-document `#reference` (an SVG paint server) stays, and everything else becomes nothing.
 * `image-set()`, `src()` and `cross-fade()` can name a resource as a bare string that this cannot
 * follow, so their names are broken, which makes the declaration invalid and the browser drops it.
 */
function rewriteCssUrls(css: string, fromPath: string, images: ImageEmbedder): string {
  return css
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]*))\s*\)/giu,
      (
        _match,
        double: string | undefined,
        single: string | undefined,
        bare: string | undefined,
      ) => {
        const reference = (double ?? single ?? bare ?? '').trim();
        if (reference.startsWith('#')) return `url("${reference.replace(/["\\]/gu, '')}")`;
        const embedded = images.embed(fromPath, reference);
        return embedded === null ? EMPTY_URL : `url("${embedded}")`;
      },
    )
    .replace(/(?:-webkit-)?image-set\(|cross-fade\(|\bsrc\(/giu, 'removed-by-reader(');
}

/**
 * A stylesheet's rules, minus the ones that fetch: `@font-face` and `@import`.
 *
 * Parsed by the browser's own CSS parser rather than a pattern, so a comment or a string that
 * looks like a rule is not mistaken for one. A browser without constructable stylesheets gets no
 * book styling, which is a plainer chapter and not an unsafe one.
 */
function stripFetchingRules(css: string): string {
  let sheet: CSSStyleSheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const serialise = (rules: CSSRuleList): string =>
    Array.from(rules)
      .map((rule) => {
        if (rule instanceof CSSFontFaceRule || rule instanceof CSSImportRule) return '';
        if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
          const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
          return `${prelude} { ${serialise(rule.cssRules)} }`;
        }
        return rule.cssText;
      })
      .join('\n');
  return serialise(sheet.cssRules);
}

function bookStyles(css: string, fromPath: string, images: ImageEmbedder): string {
  return rewriteCssUrls(stripFetchingRules(css), fromPath, images);
}

function readableText(book: EpubBook, path: string): string | null {
  const bytes = book.readEntry(path);
  return bytes === null ? null : new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/u, '');
}

/** The chapter's markup as a document, preferring the strict XHTML reading a book is written for. */
function parseChapter(source: string): Document {
  const xml = new DOMParser().parseFromString(source, 'application/xhtml+xml');
  return xml.getElementsByTagName('parsererror').length === 0 &&
    xml.documentElement.localName === 'html'
    ? xml
    : new DOMParser().parseFromString(source, 'text/html');
}

function baseStylesheet({ palette, fontScale }: EpubChapterOptions): string {
  return `
html { color-scheme: ${palette.colorScheme}; font-size: ${String(fontScale)}% !important; background: ${palette.background} !important; color: ${palette.text} !important; }
body { box-sizing: border-box; max-width: 40rem; margin: 0 auto !important; padding: 1.5rem 1.25rem 3rem !important; font-family: ${palette.fontFamily}; line-height: 1.65; overflow-wrap: anywhere; background: ${palette.background} !important; color: ${palette.text} !important; }
body * { color: inherit !important; background-color: transparent !important; }
a, a * { color: ${palette.accent} !important; }
img, svg { max-width: 100%; height: auto; }
hr, td, th { border-color: ${palette.divider} !important; }
pre, code { white-space: pre-wrap; }
table { max-width: 100%; }
`;
}

export function buildEpubChapterDocument(
  book: EpubBook,
  index: number,
  options: EpubChapterOptions,
): string {
  const item = book.spine[index];
  if (item === undefined) throw new RangeError('That chapter is not in this book.');
  const source = readableText(book, item.path);
  if (source === null) throw new RangeError('That chapter could not be read from the book.');

  const parsed = parseChapter(source);
  // A fresh HTML document, and the parsed chapter imported into it, so the markup is serialised
  // by the HTML serialiser: XHTML's `<div/>` is an unclosed `<div>` to an HTML parser, and the
  // difference would swallow the rest of the chapter.
  const target = document.implementation.createHTMLDocument('');
  const root = target.importNode(parsed.documentElement, true);
  target.replaceChild(root, target.documentElement);
  // A chapter that parsed without a head or a body (valid XHTML needs both; a sloppy book may
  // not have them) gets empty ones, because the rest of this function writes into them.
  const head =
    root.querySelector(':scope > head') ??
    root.insertBefore(target.createElement('head'), root.firstChild);
  const body =
    root.querySelector(':scope > body') ?? root.appendChild(target.createElement('body'));

  const images = new ImageEmbedder(book);
  const stylesheets: HTMLStyleElement[] = [];
  const makeStyle = (css: string): HTMLStyleElement => {
    const style = target.createElement('style');
    style.textContent = css;
    return style;
  };

  for (const element of Array.from(root.querySelectorAll('*'))) {
    if (!element.isConnected) continue;
    const name = element.localName.toLowerCase();

    if (name === 'link') {
      const rel = (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u);
      const href = element.getAttribute('href');
      const path = href === null ? null : resolveArchivePath(item.path, href);
      const text = rel.includes('stylesheet') && path !== null ? readableText(book, path) : null;
      if (text !== null && path !== null)
        stylesheets.push(makeStyle(bookStyles(text, path, images)));
      element.remove();
      continue;
    }
    if (name === 'style') {
      stylesheets.push(makeStyle(bookStyles(element.textContent, item.path, images)));
      element.remove();
      continue;
    }
    if (REMOVED_ELEMENTS.has(name)) {
      element.remove();
      continue;
    }

    if (name === 'a') {
      const href = element.getAttribute('href') ?? element.getAttribute('xlink:href');
      if (href !== null) {
        const kind = classifyLink(item.path, href);
        if (kind === 'external' && element.namespaceURI === XHTML_NAMESPACE) {
          const span = target.createElement('span');
          span.append(...Array.from(element.childNodes));
          span.append(target.createTextNode(` (${href.trim().slice(0, 2000)})`));
          element.replaceWith(span);
          continue;
        }
        if (kind === 'fragment' || kind === 'archive')
          element.setAttribute('title', INTERNAL_LINK_TITLE);
      }
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      if (attributeName.startsWith('on')) {
        element.removeAttribute(attribute.name);
      } else if (attributeName === 'style' || /url\(/iu.test(attribute.value)) {
        attribute.value = rewriteCssUrls(attribute.value, item.path, images);
      } else if (REFERENCE_ATTRIBUTES.has(attributeName)) {
        const value = attribute.value.trim();
        const isImage =
          (name === 'img' && attributeName === 'src') ||
          (name === 'image' && (attributeName === 'href' || attributeName === 'xlink:href'));
        if (isImage) {
          const embedded = images.embed(item.path, value);
          if (embedded === null) element.removeAttribute(attribute.name);
          else attribute.value = embedded;
        } else if (!(value.startsWith('#') && name !== 'a')) {
          element.removeAttribute(attribute.name);
        }
      }
    }
  }

  if (options.fragment !== null) startAtElement(target, body, options.fragment);

  const meta = target.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', EPUB_CHAPTER_POLICY);
  // The policy first, then the application's styling, then the book's: the policy has to be in
  // force before anything it governs is parsed, and the book's own rules come last so they still
  // win everything the application's rules do not insist on.
  head.prepend(meta, makeStyle(baseStylesheet(options)));
  head.append(...stylesheets);

  return `<!doctype html>${target.documentElement.outerHTML}`;
}

/**
 * Drops everything before an element, so the chapter opens where a table-of-contents entry points.
 *
 * The frame cannot be scrolled to an anchor - nothing in a sandboxed frame without scripts can be
 * told to - so the chapter is cut instead. The entry for the chapter itself has no fragment and
 * shows it whole.
 */
function startAtElement(target: Document, body: Element, id: string): void {
  const element = target.getElementById(id);
  if (element === null) return;
  let node: Node = element;
  while (node !== body && node.parentNode !== null) {
    while (node.previousSibling !== null) node.previousSibling.remove();
    node = node.parentNode;
  }
}
