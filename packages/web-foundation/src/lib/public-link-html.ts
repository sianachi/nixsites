/**
 * [SEC] Allowlist sanitizer for a public note's html. The server already escapes it; this is the
 * second wall. Unknown elements are unwrapped (script, style and embeds are removed with their
 * contents), unknown attributes are dropped, and an address survives only if it is an in-page
 * anchor, an http(s) or mailto link, or one of this link's own file URLs.
 */

const KEEP = new Set(
  'a aside blockquote br code details div em figure figcaption h2 h3 h4 hr i img li mark ol p pre s span strong summary table tbody td th tr u ul'.split(
    ' ',
  ),
);
const DROP = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'video',
  'audio',
  'form',
]);
const PLAIN_ATTRS = new Set([
  'id',
  'class',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'start',
  'data-language',
  'role',
  'tabindex',
  'loading',
  'decoding',
  'rel',
]);
const FILE_ID = /^[0-9a-f-]{36}$/i;

function safeAddress(value: string, token: string, forImage: boolean): string | null {
  // Only this link's own file route: another link's token must not be reachable from this body.
  const prefix = `/public/v1/links/${encodeURIComponent(token)}/files/`;
  if (value.startsWith(prefix) && FILE_ID.test(value.slice(prefix.length))) return value;
  if (forImage) return null;
  if (value.startsWith('#')) return value;
  return /^(https?:|mailto:)/i.test(value) ? value : null;
}

function clean(parent: Node, token: string): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (!(child instanceof Element)) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP.has(tag)) {
      child.remove();
      continue;
    }
    clean(child, token);
    if (!KEEP.has(tag)) {
      child.replaceWith(...Array.from(child.childNodes));
      continue;
    }
    for (const attribute of Array.from(child.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name === 'href' && tag === 'a') {
        const href = safeAddress(attribute.value, token, false);
        if (href === null) child.removeAttribute(attribute.name);
        else child.setAttribute('href', href);
      } else if (name === 'src' && tag === 'img') {
        const src = safeAddress(attribute.value, token, true);
        if (src === null) child.remove();
        else child.setAttribute('src', src);
      } else if (!PLAIN_ATTRS.has(name) && !name.startsWith('aria-')) {
        child.removeAttribute(attribute.name);
      }
    }
  }
}

export function sanitizePublicHtml(html: string, token: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  clean(parsed.body, token);
  return parsed.body.innerHTML;
}
