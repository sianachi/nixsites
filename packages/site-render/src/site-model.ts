import type { DatedCollection, SiteBuildManifest, SitePage } from './manifest.js';
import type { ProseAsset, ProseDownload, RenderedProse } from './html/prose.js';
import type { CustomRenderer } from './theme/custom.js';

/**
 * The site as the theme sees it: the page tree, each page's rendered body, and the dated
 * collections with their entries newest first. Built once by `renderSite`.
 */

export interface SiteNode {
  readonly page: SitePage;
  readonly parent: SiteNode | null;
  readonly children: SiteNode[];
  readonly depth: number;
  /** The rendered body, or null for a page with no prose body. */
  prose: RenderedProse | null;
  /** HTML drawn from the page's default view, or empty. */
  viewHtml: string;
  /** Set when this page is a dated collection. */
  readonly collection: DatedCollection | null;
}

export interface SiteModel {
  readonly manifest: SiteBuildManifest;
  readonly root: SiteNode;
  /** Every page in manifest (pre-)order. */
  readonly nodes: readonly SiteNode[];
  readonly byItem: ReadonlyMap<string, SiteNode>;
  /**
   * Paths of the theme's stylesheet and script, content-addressed, and for the custom layout the
   * head tags of its own stylesheets and scripts.
   */
  readonly theme: { readonly css: string; readonly js: string; readonly tags: string };
  /** Set for the custom layout: draws every page from the site's own templates. */
  custom: CustomRenderer | null;
  readonly asset: (fileItemId: string) => ProseAsset | null;
  readonly download: (fileItemId: string) => ProseDownload | null;
  /** The generated link-preview image for a page, or null when none is drawn. */
  readonly preview: (path: string, title: string, caption: string) => ProseAsset | null;
}

export function isEntry(node: SiteNode): boolean {
  return node.page.datedCollectionId !== null && node.parent?.collection != null;
}

/** A dated collection's entries, newest first, ties broken by manifest order. */
export function entriesOf(node: SiteNode): SiteNode[] {
  return node.children
    .filter(isEntry)
    .sort(
      (a, b) =>
        (b.page.publishedAt ?? '').localeCompare(a.page.publishedAt ?? '') ||
        a.page.ordinal - b.page.ordinal,
    );
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "7 October 2026", from the date part only, so no time zone or locale can move it. */
export function formatDate(value: string | null): string {
  const match = value === null ? null : /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) {
    return '';
  }
  return `${String(Number(match[3]))} ${MONTHS[Number(match[2]) - 1] ?? ''} ${match[1] ?? ''}`;
}

/** An RFC 3339 instant from a manifest date; a bare day is read as midnight UTC. */
export function rfc3339(value: string | null, fallback: string): string {
  if (value === null || value.length === 0) {
    return fallback;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

/**
 * When a page last really changed: Core's `updatedAt` (the later of the item's own change and its
 * body's last update), or the publication date when that is later (a post dated ahead of its last
 * edit). Compared as instants, not strings, since the two may be written in different offsets.
 */
export function modifiedAt(node: SiteNode): string {
  const updated = rfc3339(node.page.updatedAt, '');
  const published = rfc3339(node.page.publishedAt, '');
  return Date.parse(published) > Date.parse(updated) ? published : updated;
}

/** The latest of some RFC 3339 instants, or empty for none. */
export function latest(values: readonly string[]): string {
  return values.reduce(
    (best, value) => (best === '' || Date.parse(value) > Date.parse(best) ? value : best),
    '',
  );
}

/** The date part, for `<time datetime>`. */
export function isoDay(value: string | null): string {
  return value === null ? '' : value.slice(0, 10);
}

/** A property's tags: a list of strings, or one comma-separated string. */
export function tagsOf(node: SiteNode, property: string | null): string[] {
  if (property === null) {
    return [];
  }
  const value = node.page.properties[property];
  const raw = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [...new Set(raw.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

export function stringProperty(node: SiteNode, property: string | null): string | null {
  if (property === null) {
    return null;
  }
  const value = node.page.properties[property];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** A property image: a published asset for `nix-file:` values, never an outside URL. */
export function coverOf(
  model: SiteModel,
  node: SiteNode,
  property: string | null,
): ProseAsset | null {
  const value = stringProperty(node, property);
  if (value?.startsWith('nix-file:') !== true) {
    return null;
  }
  return model.asset(value.slice('nix-file:'.length));
}

/** Minutes to read at 220 words a minute, never less than one. */
export function readingMinutes(node: SiteNode): number {
  const words = node.prose?.text.split(/\s+/).filter((word) => word.length > 0).length ?? 0;
  return Math.max(1, Math.ceil(words / 220));
}
