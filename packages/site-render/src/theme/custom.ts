import { Liquid } from 'liquidjs';

import { escapeHtml } from '../html/escape.js';
import { SiteManifestError } from '../manifest.js';
import type { ProseAsset, ProseDownload } from '../html/prose.js';
import { entriesOf, formatDate, isEntry, type SiteModel, type SiteNode } from '../site-model.js';
import { entryTags, summaryOf } from './parts.js';
import type { ShellPage } from './shell.js';

/**
 * The custom layout: the site's own Liquid templates, stylesheets and scripts, read from the files
 * attached to its theme page, fill every page with data from the workspace.
 *
 * Templates are named after their file without `.liquid`: `layout` wraps every page (it receives
 * `nix.head`, or `nix.seo` without the built-in stylesheet and script, and `nix.body`), and `home`, `page`, `post`, `collection`, `tag` and `404` replace the
 * built-in body of that kind of page. A missing one falls back to the built-in body or shell, so a
 * theme can start with a home page alone. Any other template is a partial for `{% render %}`.
 *
 * Output is escaped unless a template says `| raw`. The pages are served in a CSP sandbox with
 * scripts allowed (`apps/sites`): theme JavaScript runs in an opaque origin, so it can reach no
 * cookie, storage or same-site credential of the Nix app on the shared domain.
 */

/** A theme file's name as published: no directory, no leading dot, nothing a URL must escape. */
export const THEME_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

const NIX_FILE = /^nix-file:([0-9a-zA-Z-]{1,64})$/;

/** Per page, so one runaway loop cannot stall the build; parse and memory are bounded likewise. */
const RENDER_LIMIT_MS = 2000;
const PARSE_LIMIT = 1 << 20;
const MEMORY_LIMIT = 64 << 20;

export interface CustomTheme {
  /** Template sources by name. */
  readonly templates: Readonly<Record<string, string>>;
  /** Published URL of each stylesheet, script and image, by file name. */
  readonly urls: ReadonlyMap<string, string>;
}

export interface CustomRenderer {
  /**
   * The whole document for one page. `head` is the full head, `seo` the same without the built-in
   * stylesheet and script; `document` wraps a body in the built-in shell.
   */
  render(
    page: ShellPage,
    head: { readonly seo: string; readonly head: string },
    document: (body: string) => string,
  ): string;
}

function fileId(value: unknown): string | null {
  const entry = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof entry !== 'string') return null;
  return NIX_FILE.exec(entry)?.[1] ?? (/^[0-9a-zA-Z-]{1,64}$/.test(entry) ? entry : null);
}

function kindOf(page: ShellPage): string {
  if (page.notFound === true) return '404';
  if (page.path === '/') return 'home';
  const own = page.current?.page.path === page.path ? page.current : null;
  if (own === null) return 'tag';
  if (own.collection !== null) return 'collection';
  return isEntry(own) ? 'post' : 'page';
}

export function createCustomRenderer(model: SiteModel, theme: CustomTheme): CustomRenderer {
  const { settings, canonicalOrigin } = model.manifest;
  const engine = new Liquid({
    templates: theme.templates,
    outputEscape: 'escape',
    strictFilters: true,
    ownPropertyOnly: true,
    timezoneOffset: 0,
    parseLimit: PARSE_LIMIT,
    renderLimit: RENDER_LIMIT_MS,
    memoryLimit: MEMORY_LIMIT,
  });
  // A template mistake fails the build with Liquid's own message, which names the line.
  const renderTemplate = (name: string, context: object): string => {
    try {
      return String(engine.renderFileSync(name, context));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SiteManifestError(`The theme's ${name} template failed: ${detail.slice(0, 300)}`);
    }
  };
  const published = (asset: ProseAsset | ProseDownload | null): string => asset?.url ?? '';
  // A file property's published URL: an image as an asset, a PDF or text file as a download.
  engine.registerFilter('file_url', (value: unknown) => {
    const id = fileId(value);
    return id === null ? '' : published(model.asset(id) ?? model.download(id));
  });
  engine.registerFilter('theme_url', (name: unknown) =>
    typeof name === 'string' ? (theme.urls.get(name) ?? '') : '',
  );
  engine.registerFilter('date_label', (value: unknown) =>
    typeof value === 'string' ? formatDate(value) : '',
  );

  // One object per page, built on first use; the tree is reached through getters so a template
  // that never asks for children never builds them.
  const drops = new Map<SiteNode, object>();
  const drop = (node: SiteNode): object => {
    let value = drops.get(node);
    if (value === undefined) {
      const collection = node.collection !== null;
      value = {
        title: node.page.title,
        path: node.page.path,
        url: `${canonicalOrigin}${node.page.path}`,
        type: node.page.type,
        properties: node.page.properties,
        date: node.page.publishedAt,
        summary: summaryOf(node),
        tags: isEntry(node) ? entryTags(node) : [],
        content: node.prose?.html ?? '',
        view: node.viewHtml,
        is_collection: collection,
        is_post: isEntry(node),
        get parent() {
          return node.parent === null ? null : drop(node.parent);
        },
        get children() {
          return node.children.map(drop);
        },
        get entries() {
          return collection ? entriesOf(node).map(drop) : [];
        },
      };
      drops.set(node, value);
    }
    return value;
  };

  const site = {
    name: settings.name,
    description: settings.description,
    accent: settings.accent,
    author: settings.author ?? '',
    language: settings.language,
    url: canonicalOrigin,
    navigation: settings.navigation,
    footer_text: settings.footerText,
    built_with_nix: settings.builtWithNix,
    get home() {
      return drop(model.root);
    },
    get pages() {
      return model.nodes.map(drop);
    },
  };

  return {
    render(page, head, document) {
      const kind = kindOf(page);
      const context = {
        site,
        page: page.current === null || page.current === undefined ? null : drop(page.current),
        nix: { kind, path: page.path, title: page.title, ...head, body: page.body },
      };
      const body = theme.templates[kind] === undefined ? page.body : renderTemplate(kind, context);
      if (theme.templates.layout === undefined) {
        return document(body);
      }
      return renderTemplate('layout', { ...context, nix: { ...context.nix, body } });
    },
  };
}

/** The tags a page head carries for the theme's own stylesheets and scripts. */
export function themeTags(urls: ReadonlyMap<string, string>): string {
  const names = [...urls.keys()].sort();
  return [
    ...names
      .filter((name) => name.endsWith('.css'))
      .map((name) => `<link rel="stylesheet" href="${escapeHtml(urls.get(name) ?? '')}">`),
    ...names
      .filter((name) => name.endsWith('.js'))
      .map((name) => `<script src="${escapeHtml(urls.get(name) ?? '')}" defer></script>`),
  ].join('\n');
}
