import { createHash } from 'node:crypto';

import { readBundleStream, type ItemBody, type LossEntry } from '@nix/export';
import {
  MAX_DOWNLOAD_BYTES,
  MAX_VIDEO_BYTES,
  UnsupportedDownload,
  collectFileReferences,
  downloadType,
  loadPreviewRasterizer,
  parseSiteManifest,
  prepareDownload,
  parseSitePages,
  renderSite,
  stripImageMetadata,
  type FileReference,
  type PublishedDownload,
  type RenderedFile,
  type SitePage,
  type StrippedImage,
  UnsupportedImage,
} from '@nix/site-render';

import { mapLimited } from '../shared/map-limited.ts';
import type { ObjectTransfer } from '../shared/object-transfer.ts';
import type { CoreClient, Execution, UploadEntry } from './core-client.ts';
import { JobError, type JobContext } from './dispatch.ts';

/**
 * One `site.build` job: read the sealed manifest from Core, fetch each page's body at the pinned
 * content position and each referenced image, render the whole site in memory, write it, and take
 * it live.
 *
 * **Core decides everything that matters.** The worker never picks a key, a bucket or what a
 * hostname points at: Core derives each object key from the digest and path the worker declares,
 * signs a capability for exactly that, and returns the host manifest bytes at seal. The host
 * manifest is written last, so an interrupted build is never served.
 *
 * Idempotent: objects are create-only and keyed by content, so a redelivered job rewrites nothing
 * (an object that is already there counts as written).
 */

const PAGE_BATCH = 200;
const UPLOAD_BATCH = 100;
const BODY_CONCURRENCY = 4;
const FILE_CONCURRENCY = 4;
const UPLOAD_CONCURRENCY = 8;
const MAX_BODY_BYTES = 32 << 20;
const MAX_IMAGE_BYTES = 10 << 20;
const MAX_RENDERED_BYTES = 256 << 20;
const MAX_LOSS_ENTRIES = 128;

export interface BuildDeps {
  readonly core: CoreClient;
  /** Object storage capabilities (Core-signed URLs on the sites bucket). */
  readonly objects: ObjectTransfer;
  /** Collaboration, pinned to its own origin; the only place the internal secret and a bearer go. */
  readonly collab: ObjectTransfer;
  readonly internalSecret: string;
}

/** The media type Core accepts for an extension; it rejects any other pairing. */
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  pdf: 'application/pdf',
  csv: 'text/csv',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function lossStrings(loss: readonly LossEntry[]): string[] {
  const lines = loss.map((entry) =>
    // eslint-disable-next-line no-control-regex
    `${entry.kind}: ${entry.detail}`.replaceAll(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500),
  );
  if (lines.length > MAX_LOSS_ENTRIES) {
    const extra = lines.length - (MAX_LOSS_ENTRIES - 1);
    return [
      ...lines.slice(0, MAX_LOSS_ENTRIES - 1),
      `${String(extra)} more omissions were not listed.`,
    ];
  }
  return lines;
}

interface FetchedFile {
  readonly image: StrippedImage | null;
  readonly download: PublishedDownload | null;
  readonly skipped: LossEntry | null;
}

/** One file as a page first uses it: Core's read capability, the bytes, and the published form. */
async function fetchFile(
  deps: BuildDeps,
  execution: Execution,
  reference: FileReference,
  signal: AbortSignal,
): Promise<FetchedFile> {
  const none = { image: null, download: null, skipped: null };
  const file = await deps.core.file(execution, reference.fileItemId, reference.pageItemId, signal);
  if (file === null) {
    // A link target is usually a page that is not published, not a file; the page says so.
    return reference.kind === 'embed'
      ? {
          ...none,
          skipped: {
            itemId: reference.pageItemId,
            kind: 'image-not-embedded',
            detail: 'An image was not available to this site and was left out.',
          },
        }
      : none;
  }
  // A linked picture is not a download, and the block or reference does not show pictures.
  if (reference.kind === 'link' && downloadType(file.mediaType) === null) return none;
  const isDownload = downloadType(file.mediaType) !== null;
  const bytes = await deps.objects.download(
    file.url,
    Math.min(
      file.byteLength,
      isDownload
        ? file.mediaType.startsWith('video/')
          ? MAX_VIDEO_BYTES
          : MAX_DOWNLOAD_BYTES
        : MAX_IMAGE_BYTES,
    ),
    signal,
  );
  if (sha256(bytes) !== file.sha256) {
    throw new JobError('site_image_corrupt', 'A file did not match its recorded digest.');
  }
  try {
    return isDownload
      ? {
          ...none,
          download: prepareDownload(bytes, file.mediaType, file.fileName ?? 'download'),
        }
      : { ...none, image: stripImageMetadata(bytes, file.mediaType) };
  } catch (error) {
    if (!(error instanceof UnsupportedImage) && !(error instanceof UnsupportedDownload)) {
      throw error;
    }
    return {
      ...none,
      skipped: {
        itemId: reference.pageItemId,
        kind: 'image-not-embedded',
        detail: error.message,
      },
    };
  }
}

export async function buildSite(deps: BuildDeps, context: JobContext): Promise<unknown> {
  const { core } = deps;
  const { execution, signal } = context;

  // 1. The manifest and its pages.
  let manifest;
  let pages: SitePage[];
  try {
    manifest = parseSiteManifest(await core.manifest(execution, signal));
    const raw: unknown[] = [];
    let after = -1;
    for (;;) {
      const batch = await core.pages(execution, after, PAGE_BATCH, signal);
      raw.push(...batch.pages);
      if (batch.next === null) break;
      after = batch.next;
    }
    pages = parseSitePages(raw, manifest);
  } catch (error) {
    if (error instanceof Error && error.name === 'SiteManifestError') {
      throw new JobError('site_manifest_invalid', error.message);
    }
    throw error;
  }

  // 2. Bodies, pinned to the content position the manifest recorded.
  const bodies = new Map<string, ItemBody | null>();
  const withContent = pages.filter((page) => page.content !== null && page.content.seq > 0);
  await mapLimited(withContent, BODY_CONCURRENCY, signal, async (page) => {
    const source = await core.body(execution, page.itemId, signal);
    const text = Buffer.from(
      await deps.collab.download(source.sourceUrl, MAX_BODY_BYTES, signal, {
        authorization: `Bearer ${source.bearerToken}`,
        'x-nix-internal-secret': deps.internalSecret,
      }),
    ).toString('utf8');
    const stream = readBundleStream(text.split('\n'));
    const bundle = stream.bundles.find((candidate) => candidate.id === page.itemId);
    const body = bundle?.body ?? null;
    if (body === null) {
      // Never publish a hole where a page's text should be.
      throw new JobError(
        'site_body_withheld',
        'A page body could not be read, so the build was stopped.',
      );
    }
    bodies.set(page.itemId, body);
  });

  // 3. Images, captured diagrams (SVG, re-sanitised by `stripImageMetadata`) and downloads (PDF,
  // text, CSV): Core validates each reference against the manifest and returns a read capability.
  const assets = new Map<string, StrippedImage>();
  const downloads = new Map<string, PublishedDownload>();
  const skipped: LossEntry[] = [];
  const references = collectFileReferences(pages, bodies);
  // Each file is fetched once, for the first page that uses it; files fetch side by side, and their
  // results are applied in reference order so the output does not depend on which finished first.
  const firstUse = new Map<string, FileReference>();
  for (const reference of references) {
    if (!firstUse.has(reference.fileItemId)) firstUse.set(reference.fileItemId, reference);
  }
  const fetched = await mapLimited(
    [...firstUse.values()],
    FILE_CONCURRENCY,
    signal,
    async (reference) => ({
      reference,
      ...(await fetchFile(deps, execution, reference, signal)),
    }),
  );
  const copies = new Map<string, unknown>();
  for (const { reference, image, download, skipped: skip } of fetched) {
    if (skip !== null) skipped.push(skip);
    if (image !== null) assets.set(reference.fileItemId, image);
    if (download !== null) downloads.set(reference.fileItemId, download);
    copies.set(reference.fileItemId, image ?? download);
  }
  for (const reference of references) {
    if (firstUse.get(reference.fileItemId) === reference) continue;
    signal.throwIfAborted();
    // Core records the (page, file) pair, so ask again for each page that uses a known file.
    if (copies.get(reference.fileItemId) !== null)
      await core.file(execution, reference.fileItemId, reference.pageItemId, signal);
  }

  // 4. Render, in memory.
  // Each page's link-preview card; the rasteriser loads once per process.
  const previews = await loadPreviewRasterizer();
  const rendered = renderSite({ manifest, pages, bodies, assets, downloads, previews });
  const files = rendered.files;
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (totalBytes > MAX_RENDERED_BYTES) {
    throw new JobError(
      'site_too_large',
      'The rendered site is larger than the worker builds in one pass.',
    );
  }
  const index = files.find((file) => file.path === '_nix/build.json');
  if (index === undefined) {
    throw new JobError('site_render_failed', 'The renderer produced no build index.');
  }

  // 5. Upload in batches. Core derives every key and signs for the exact digest and length.
  const entryOf = (file: RenderedFile): UploadEntry => {
    const extension = file.path.slice(file.path.lastIndexOf('.') + 1);
    const mediaType = MEDIA_TYPES[extension];
    if (mediaType === undefined) {
      throw new JobError(
        'site_render_failed',
        `The renderer produced a file type Core does not accept (${extension}).`,
      );
    }
    const digest = sha256(file.bytes);
    return file.kind === 'asset'
      ? {
          path: `${digest}.${extension}`,
          kind: 'asset',
          byteLength: file.bytes.length,
          sha256: digest,
          mediaType,
        }
      : {
          path: file.path,
          kind: 'build',
          byteLength: file.bytes.length,
          sha256: digest,
          mediaType,
        };
  };
  for (let start = 0; start < files.length; start += UPLOAD_BATCH) {
    signal.throwIfAborted();
    const batch = files.slice(start, start + UPLOAD_BATCH);
    const targets = await core.uploads(execution, batch.map(entryOf), signal);
    if (targets.length !== batch.length) {
      throw new JobError(
        'site_upload_mismatch',
        'Core returned a different number of upload targets than were asked for.',
      );
    }
    await mapLimited(batch, UPLOAD_CONCURRENCY, signal, (file, offset) =>
      deps.objects.putCreateOnly(
        (targets[offset] as { uploadUrl: string }).uploadUrl,
        file.bytes,
        signal,
      ),
    );
  }

  // 6. Seal, write the host manifests Core composed, then go live.
  const loss = lossStrings([...rendered.loss, ...skipped]);
  const writes = await core.seal(
    execution,
    { fileCount: files.length, totalBytes, buildIndexSha256: sha256(index.bytes), loss },
    signal,
  );
  for (const write of writes) {
    await deps.objects.putReplacing(write.uploadUrl, Buffer.from(write.body, 'utf8'), signal);
  }
  await core.activated(execution, signal);

  return {
    buildId: manifest.buildId,
    pageCount: pages.length,
    fileCount: files.length,
    totalBytes,
    lossCount: loss.length,
    loss: loss.slice(0, 20),
  };
}
