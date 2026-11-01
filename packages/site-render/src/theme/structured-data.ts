import { isEntry, modifiedAt, rfc3339, type SiteModel, type SiteNode } from '../site-model.js';
import { entryTags } from './parts.js';

/**
 * Schema.org structured data for a page, as one JSON-LD block in the head.
 *
 * **CSP.** The site's policy is `script-src 'self'`, with no inline script allowed, and this block
 * still applies. A `<script>` whose type is not a JavaScript MIME type is a data block: HTML's
 * "prepare the script element" algorithm returns before the inline-script CSP check runs (that
 * check only exists for classic and module scripts), so `script-src` never governs it. Checked
 * under this exact policy in Chromium and WebKit: no `securitypolicyviolation` for the block, while
 * an inline `<script>` beside it is refused. Search engines read it from the markup unexecuted. Hashing each block into the policy would be impossible
 * anyway, since the policy is one shared response header for every page.
 *
 * **Escaping.** The block's text ends at the first `</script`, and U+2028 and U+2029 break older
 * JavaScript parsers, so every `<`, `>`, `&` and those two separators is written as a `\uXXXX`
 * escape: still the same JSON string, never markup.
 *
 * Types: `WebSite` on the home page (with the author as a `Person` on a blog), `BlogPosting` for
 * a dated entry, `TechArticle` for a docs page, `WebPage` otherwise, and a `BreadcrumbList` on
 * every page below the root.
 */

export interface StructuredPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly current: SiteNode | null;
  /** The page's preview image, absolute, or null. */
  readonly image: string | null;
}

type Json = Record<string, unknown>;

export function jsonLdScript(data: unknown): string {
  const json = JSON.stringify(data).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `<script type="application/ld+json">${json}</script>`;
}

function person(model: SiteModel): Json {
  const { settings, canonicalOrigin } = model.manifest;
  const name = settings.author?.trim() ?? '';
  return {
    '@type': 'Person',
    name: name.length > 0 ? name : settings.name,
    url: `${canonicalOrigin}/`,
  };
}

/** The page's ancestors, root first, then the page itself (a generated page after its owner). */
function breadcrumb(model: SiteModel, page: StructuredPage): Json | null {
  if (page.path === '/' || page.current === null) {
    return null;
  }
  const chain: { name: string; path: string }[] = [];
  for (let at: SiteNode | null = page.current; at !== null; at = at.parent) {
    chain.unshift({
      name: at.parent === null ? model.manifest.settings.name : at.page.title,
      path: at.page.path,
    });
  }
  if (page.current.page.path !== page.path) {
    chain.push({ name: page.title, path: page.path });
  }
  return {
    '@type': 'BreadcrumbList',
    itemListElement: chain.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: `${model.manifest.canonicalOrigin}${entry.path}`,
    })),
  };
}

export function structuredData(model: SiteModel, page: StructuredPage): Json {
  const { settings, canonicalOrigin, layout, builtAt } = model.manifest;
  const url = `${canonicalOrigin}${page.path}`;
  const node = page.current?.page.path === page.path ? page.current : null;
  const description = page.description.length > 0 ? { description: page.description } : {};
  const image = page.image === null ? {} : { image: [page.image] };
  const graph: Json[] = [];

  if (page.path === '/') {
    const author = settings.author?.trim() ?? '';
    const withPerson = layout !== 'docs' && author.length > 0;
    graph.push({
      '@type': 'WebSite',
      '@id': `${canonicalOrigin}/#website`,
      name: settings.name,
      url,
      inLanguage: settings.language,
      ...(settings.description.length > 0 ? { description: settings.description } : {}),
      ...(withPerson ? { author: { '@id': `${canonicalOrigin}/#person` } } : {}),
    });
    if (withPerson) {
      graph.push({ ...person(model), '@id': `${canonicalOrigin}/#person` });
    }
  } else if (node !== null && isEntry(node)) {
    const tags = entryTags(node);
    graph.push({
      '@type': 'BlogPosting',
      // Google shows at most 110 characters of a headline.
      headline: page.title.slice(0, 110),
      ...description,
      datePublished: rfc3339(node.page.publishedAt, rfc3339(node.page.createdAt, builtAt)),
      dateModified: modifiedAt(node) || builtAt,
      author: person(model),
      ...image,
      ...(tags.length > 0 ? { keywords: tags.join(', ') } : {}),
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      url,
      inLanguage: settings.language,
    });
  } else if (node !== null && layout === 'docs' && node.collection === null) {
    graph.push({
      '@type': 'TechArticle',
      headline: page.title.slice(0, 110),
      ...description,
      datePublished: rfc3339(node.page.createdAt, builtAt),
      dateModified: modifiedAt(node) || builtAt,
      author: person(model),
      ...image,
      mainEntityOfPage: { '@type': 'WebPage', '@id': url },
      url,
      inLanguage: settings.language,
    });
  } else {
    graph.push({
      '@type': node?.collection != null || node === null ? 'CollectionPage' : 'WebPage',
      name: page.title,
      ...description,
      url,
      inLanguage: settings.language,
      ...(node === null ? {} : { dateModified: modifiedAt(node) || builtAt }),
      isPartOf: { '@id': `${canonicalOrigin}/#website` },
    });
  }

  const trail = breadcrumb(model, page);
  if (trail !== null) {
    graph.push(trail);
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}
