import { escapeHtml, safeHref } from '../html/escape.js';
import type { ProseAsset } from '../html/prose.js';
import { formatDate, isEntry, modifiedAt, type SiteModel, type SiteNode } from '../site-model.js';
import { isNoindex } from './facts.js';
import { entryTags } from './parts.js';
import { jsonLdScript, structuredData } from './structured-data.js';

/**
 * The document every page shares: head metadata, header, skip link, footer.
 *
 * Head carries the canonical URL, Open Graph, article and Twitter metadata (the page's cover as
 * the preview image, or else its generated card), schema.org JSON-LD, robots directives and the
 * Atom feeds. No inline script or style anywhere, so the site's content security policy can forbid
 * both; the JSON-LD block is data, not script (see `structured-data.ts`).
 */

export const BUILT_WITH_NIX_URL = 'https://github.com/sianachi/nix';

export interface ShellPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'website' | 'article';
  readonly image: ProseAsset | null;
  readonly publishedAt?: string | null;
  readonly current?: SiteNode | null;
  readonly body: string;
  readonly search?: boolean;
  /** For 404: no canonical link, and robots told not to index. */
  readonly notFound?: boolean;
}

export function absolute(model: SiteModel, path: string): string {
  return `${model.manifest.canonicalOrigin}${path}`;
}

function feedLinks(model: SiteModel): string {
  return model.nodes
    .filter((node) => node.collection !== null)
    .map(
      (node) =>
        `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(`${model.manifest.settings.name}: ${node.page.title}`)}" href="${escapeHtml(`${node.page.path}feed.xml`)}">`,
    )
    .join('');
}

function navigation(model: SiteModel, current: SiteNode | null | undefined): string {
  const items = model.manifest.settings.navigation
    .map((entry) => {
      const href = safeHref(entry.path);
      if (href === null) {
        return '';
      }
      const active =
        current !== null &&
        current !== undefined &&
        href.startsWith('/') &&
        href !== '/' &&
        current.page.path.startsWith(href);
      return `<li><a href="${escapeHtml(href)}"${active ? ' aria-current="true"' : ''}>${escapeHtml(entry.label)}</a></li>`;
    })
    .join('');
  return items.length === 0 ? '' : `<nav class="nix-nav" aria-label="Site"><ul>${items}</ul></nav>`;
}

/** The short line under the title on a generated preview card: a date, a section, or the site. */
function caption(model: SiteModel, page: ShellPage): string {
  if (page.publishedAt != null) {
    return formatDate(page.publishedAt);
  }
  const current = page.current ?? null;
  if (current === null || page.path === '/') {
    return model.manifest.settings.description;
  }
  // A generated page (a tag) sits in its owner; a real page in its parent.
  const section = current.page.path === page.path ? current.parent : current;
  return section?.parent == null ? '' : section.page.title;
}

/** `en-GB` as Open Graph writes it, `en_GB`. */
function ogLocale(language: string): string {
  const [lang = '', region] = language.split('-');
  return region === undefined || !/^[a-zA-Z]{2}$/.test(region)
    ? lang.toLowerCase()
    : `${lang.toLowerCase()}_${region.toUpperCase()}`;
}

export function renderShell(model: SiteModel, page: ShellPage): string {
  const { settings, layout } = model.manifest;
  const name = settings.name;
  const fullTitle = page.path === '/' && page.title === name ? name : `${page.title} - ${name}`;
  const url = absolute(model, page.path);
  const description = page.description.length > 0 ? page.description : settings.description;
  const picture =
    page.notFound === true
      ? null
      : (page.image ?? model.preview(page.path, page.title, caption(model, page)));
  const image = picture === null ? null : absolute(model, picture.url);
  // The page's own node, when this page is one (not a generated tag page or the 404).
  const own = page.current?.page.path === page.path ? page.current : null;
  const article = page.kind === 'article' && own !== null;
  const noindex = page.notFound === true || settings.noindex || (own !== null && isNoindex(own));

  const tags = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(fullTitle)}</title>`,
    description.length > 0 ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    noindex ? `<meta name="robots" content="noindex">` : '',
    page.notFound === true ? '' : `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta name="generator" content="Nix">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta property="og:site_name" content="${escapeHtml(name)}">`,
    `<meta property="og:title" content="${escapeHtml(page.title)}">`,
    description.length > 0
      ? `<meta property="og:description" content="${escapeHtml(description)}">`
      : '',
    `<meta property="og:type" content="${page.kind}">`,
    `<meta property="og:locale" content="${escapeHtml(ogLocale(settings.language))}">`,
    page.notFound === true ? '' : `<meta property="og:url" content="${escapeHtml(url)}">`,
    image === null ? '' : `<meta property="og:image" content="${escapeHtml(image)}">`,
    picture?.width == null || picture.height == null
      ? ''
      : `<meta property="og:image:width" content="${String(picture.width)}">\n<meta property="og:image:height" content="${String(picture.height)}">`,
    image === null ? '' : `<meta property="og:image:alt" content="${escapeHtml(page.title)}">`,
    page.publishedAt == null
      ? ''
      : `<meta property="article:published_time" content="${escapeHtml(page.publishedAt)}">`,
    article
      ? `<meta property="article:modified_time" content="${escapeHtml(modifiedAt(own))}">`
      : '',
    ...(article && isEntry(own)
      ? entryTags(own).map((tag) => `<meta property="article:tag" content="${escapeHtml(tag)}">`)
      : []),
    `<meta name="twitter:card" content="${image === null ? 'summary' : 'summary_large_image'}">`,
  ];
  const builtIn = [
    `<link rel="stylesheet" href="${model.theme.css}">`,
    `<script src="${model.theme.js}"></script>`,
  ];
  const tail = [
    feedLinks(model),
    page.notFound === true
      ? ''
      : jsonLdScript(
          structuredData(model, {
            path: page.path,
            title: page.title,
            description,
            current: page.current ?? null,
            image,
          }),
        ),
  ];
  const join = (lines: readonly string[]): string =>
    lines.filter((line) => line.length > 0).join('\n');
  const meta = join([...tags, ...builtIn, model.theme.tags, ...tail]);
  // Without the built-in stylesheet and script, for a custom layout that styles everything itself.
  const seo = join([...tags, model.theme.tags, ...tail]);

  const search =
    page.search === true
      ? `<div class="nix-search" data-nix-search="/_nix/search.json" role="search" hidden><label class="sr-only" for="nix-search-input">Search ${escapeHtml(name)}</label><input id="nix-search-input" type="search" placeholder="Search" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">/</kbd><div class="nix-search-panel" hidden><p role="status" aria-live="polite"></p><ul></ul></div></div>`
      : '';

  const footer = [
    settings.footerText.length > 0 ? `<p>${escapeHtml(settings.footerText)}</p>` : '',
    `<ul><li><a href="#top">Back to top</a></li>${model.nodes
      .filter((node) => node.collection !== null)
      .map(
        (node) =>
          `<li><a href="${escapeHtml(`${node.page.path}feed.xml`)}">${escapeHtml(node.page.title)} feed</a></li>`,
      )
      .join('')}${
      settings.builtWithNix
        ? `<li><a class="nix-built" href="${BUILT_WITH_NIX_URL}"><span class="nix-glyph" aria-hidden="true"></span>Built with Nix</a></li>`
        : ''
    }</ul>`,
  ].join('');

  const document = (body: string): string => `<!doctype html>
<html lang="${escapeHtml(settings.language)}">
<head>
${meta}
</head>
<body class="nix-site nix-layout-${layout}">
<a class="nix-skip" href="#content">Skip to content</a>
<header class="nix-top"><div class="nix-top-inner"><a class="nix-brand" href="/"><span class="nix-mark" aria-hidden="true"><i></i></span>${escapeHtml(name)}</a>${navigation(model, page.current)}<div class="nix-tools">${search}<button class="nix-theme" type="button" data-nix-theme hidden aria-label="Switch theme"><span aria-hidden="true"></span></button></div></div></header>
<main id="content" class="nix-main" tabindex="-1">
${body}
</main>
<footer class="nix-foot"><div class="nix-foot-inner">${footer}</div></footer>
</body>
</html>
`;
  return model.custom === null
    ? document(page.body)
    : model.custom.render(page, { seo, head: meta }, document);
}

/** Ancestors as a breadcrumb, root first, ending at the page's parent. */
export function crumbs(node: SiteNode, siteName: string): string {
  const chain: SiteNode[] = [];
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    chain.unshift(parent);
  }
  if (chain.length === 0) {
    return '';
  }
  return `<nav class="nix-crumbs" aria-label="Breadcrumb"><ol>${chain
    // The root's title is the home page's headline; the site's name reads better as a crumb.
    .map(
      (entry) =>
        `<li><a href="${escapeHtml(entry.page.path)}">${escapeHtml(entry.parent === null ? siteName : entry.page.title)}</a></li>`,
    )
    .join('')}</ol></nav>`;
}
