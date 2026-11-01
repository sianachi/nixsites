import type { SchemaSnapshot, ViewsSnapshot } from '@nix/export';
import type { ChartInput } from '@nix/chart-render';
import { z } from 'zod';

/**
 * The build manifest Core seals for a site build, and the pages it lists (ADR-0063, plan section 2).
 *
 * Parsed at the boundary: the renderer trusts nothing about paths or counts that it did not check
 * here, because a path becomes a file name in the output and a page count bounds the work.
 */

export const MAX_SITE_PAGES = 5_000;

/** A page path: root, or lowercase slug segments each ending in a slash. */
export const SITE_PATH = /^\/([a-z0-9][a-z0-9-]{0,79}\/)*$/;

const pathSchema = z.string().max(2048).regex(SITE_PATH, 'not a site path');

const datedCollectionSchema = z.object({
  itemId: z.string().min(1),
  dateProperty: z.string().min(1),
  tagsProperty: z.string().nullable(),
  coverProperty: z.string().nullable(),
  summaryProperty: z.string().nullable(),
});

const manifestSchema = z.object({
  formatVersion: z.literal(1),
  siteId: z.string().min(1),
  buildId: z.string().min(1),
  workspaceId: z.string().min(1),
  rootItemId: z.string().min(1),
  layout: z.enum(['docs', 'blog', 'custom']),
  settings: z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    navigation: z
      .array(z.object({ label: z.string().min(1).max(80), path: z.string().max(2048) }))
      .max(12),
    footerText: z.string().max(500),
    builtWithNix: z.boolean(),
    language: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/),
    // Optional so a manifest from a Core that predates them still parses.
    /** Hide the whole site from search engines: robots.txt disallows all, every page says noindex. */
    noindex: z.boolean().default(false),
    /** The person who writes the site, for structured data; empty or absent for none. */
    author: z.string().max(200).nullish(),
    /** The shape drawn before headings, cards and the brand. */
    headingMark: z.enum(['square', 'diamond', 'none']).default('square'),
    /** The type family for headings and body. */
    typeface: z.enum(['rounded', 'serif', 'legible']).default('rounded'),
    /** The vertical rhythm: space between blocks, sections and rows. */
    spacing: z.enum(['compact', 'comfortable', 'airy']).default('comfortable'),
    /** For the custom layout: the page whose attached files are the theme; never published. */
    themeItemId: z.string().min(1).nullish(),
  }),
  canonicalOrigin: z.string().regex(/^https?:\/\/[^/\s]+$/),
  builtAt: z.iso.datetime({ offset: true }),
  pageCount: z.int().min(1).max(MAX_SITE_PAGES),
  datedCollections: z.array(datedCollectionSchema),
  redirects: z.array(z.object({ from: pathSchema, toItemId: z.string().min(1) })),
});

export type SiteBuildManifest = z.infer<typeof manifestSchema>;
export type DatedCollection = z.infer<typeof datedCollectionSchema>;

const propertyFileSchema = z.object({
  fileItemId: z.string().min(1),
  fileVersionId: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mediaType: z.string(),
  byteLength: z.int().min(0),
});

const pageSchema = z.object({
  ordinal: z.int().min(0),
  itemId: z.string().min(1),
  parentItemId: z.string().nullable(),
  path: pathSchema,
  title: z.string(),
  type: z.string(),
  seq: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  properties: z.record(z.string(), z.unknown()),
  // Snapshots come from `@nix/export` and charts from Core's chart query; both are drawn
  // defensively downstream, so their inner shape is not re-validated here.
  schema: z.unknown().nullable(),
  views: z.unknown().nullable(),
  chart: z.unknown().nullable(),
  content: z.object({ docId: z.string(), seq: z.number() }).nullable(),
  datedCollectionId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  propertyFiles: z.array(propertyFileSchema),
});

export interface SitePage extends Omit<z.infer<typeof pageSchema>, 'schema' | 'views' | 'chart'> {
  readonly schema: SchemaSnapshot | null;
  readonly views: ViewsSnapshot | null;
  readonly chart: ChartInput | null;
}

export class SiteManifestError extends Error {
  override readonly name = 'SiteManifestError';
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? 'invalid' : `${issue.path.join('.')}: ${issue.message}`;
}

/**
 * The pages a site renders. A file item with nothing under it is an attachment - a captured
 * Mermaid picture, an image, a download - and publishes through the pages that use it, never as a
 * page of its own. A file item that holds children stays a page: body type never decides structure.
 */
export function publishedPages(pages: readonly SitePage[]): SitePage[] {
  const parents = new Set(pages.map((page) => page.parentItemId));
  return pages.filter((page) => page.type !== 'file' || parents.has(page.itemId));
}

export function parseSiteManifest(json: unknown): SiteBuildManifest {
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new SiteManifestError(`The site manifest is not valid (${describe(parsed.error)}).`);
  }
  return parsed.data;
}

/**
 * The manifest's pages, checked as a set: within the page cap, matching the manifest's count,
 * each path and item unique, exactly one root page at `/`, and every parent present.
 */
export function parseSitePages(json: unknown, manifest: SiteBuildManifest): SitePage[] {
  const parsed = z.array(pageSchema).max(MAX_SITE_PAGES).safeParse(json);
  if (!parsed.success) {
    throw new SiteManifestError(`The site pages are not valid (${describe(parsed.error)}).`);
  }
  const pages = parsed.data as SitePage[];
  if (pages.length !== manifest.pageCount) {
    throw new SiteManifestError(
      `The manifest lists ${String(manifest.pageCount)} pages but ${String(pages.length)} arrived.`,
    );
  }

  const paths = new Set<string>();
  const items = new Set<string>();
  for (const page of pages) {
    if (paths.has(page.path)) {
      throw new SiteManifestError(`Two pages share the path ${page.path}.`);
    }
    if (items.has(page.itemId)) {
      throw new SiteManifestError('An item is listed twice.');
    }
    paths.add(page.path);
    items.add(page.itemId);
  }

  const root = pages.find((page) => page.itemId === manifest.rootItemId);
  if (root?.path !== '/' || root.parentItemId !== null) {
    throw new SiteManifestError('The root item must be the page at /.');
  }
  for (const page of pages) {
    if (page !== root && (page.parentItemId === null || !items.has(page.parentItemId))) {
      throw new SiteManifestError('A page sits under an item that is not in the manifest.');
    }
  }
  for (const redirect of manifest.redirects) {
    if (paths.has(redirect.from)) {
      throw new SiteManifestError(`The redirect from ${redirect.from} shadows a page.`);
    }
  }

  return [...pages].sort((a, b) => a.ordinal - b.ordinal);
}
