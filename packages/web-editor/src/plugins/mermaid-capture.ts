import { createContext, useContext, useEffect, useEffectEvent, useRef } from 'react';
import { files as fileResources, items as itemResources, type NixClient } from '@nix/api-client';
import { MAX_DIAGRAM_BYTES, sanitizeSvg } from '@nix/site-render/svg';

import { renderMermaid } from './mermaid-render';

/**
 * Mermaid capture (ADR-0063): a published site cannot run Mermaid, so the author's browser draws
 * each diagram for publishing whenever its source changes, and stores the picture as a file
 * version beside the block. The code block keeps two attributes: `renderFileId`, the file item,
 * and `renderSourceHash`, the SHA-256 of the source last captured. The picture itself is stamped
 * with that hash, so a build that finds a picture of some other source publishes the code instead.
 */

/** How long the source must stay still before it is captured. */
export const CAPTURE_DELAY_MS = 2000;

/** Stores a captured picture; `renderFileId` is the block's hint, checked by {@link storeCapture}. */
export type MermaidCaptureUpload = (svg: Blob, renderFileId: string | null) => Promise<string>;

/**
 * Present only where this session may write the note and reach Core. Read-only viewers, locked
 * notes and offline sessions get null and never capture.
 */
export const MermaidCaptureContext = createContext<MermaidCaptureUpload | null>(null);

/**
 * Stores a captured picture under `pageItemId` and returns its file item.
 *
 * The block's `renderFileId` is only a hint: any editor can plant another file's id there, and the
 * capture runs as whoever has the page open. So it is reused, as a new version, only when Core
 * says it is an SVG file whose parent is this page; anything else gets a new file under the page.
 */
export async function storeCapture(
  client: NixClient,
  input: {
    readonly workspaceId: string;
    readonly pageItemId: string;
    readonly svg: Blob;
    readonly renderFileId: string | null;
  },
): Promise<string> {
  const { workspaceId, pageItemId, svg, renderFileId } = input;
  const owned =
    renderFileId === null
      ? false
      : await Promise.all([
          client.query(itemResources.itemById(renderFileId), { forceRefresh: true }),
          client.query(fileResources.fileByItem(renderFileId), { forceRefresh: true }),
        ]).then(
          ([item, file]) =>
            item.type === 'file' &&
            item.parentId === pageItemId &&
            item.workspaceId === workspaceId &&
            file.current.mediaType === 'image/svg+xml',
          () => false,
        );
  const target = owned ? renderFileId : null;
  const upload = await client.execute(
    fileResources.beginUpload({
      workspaceId,
      parentId: target === null ? pageItemId : null,
      targetItemId: target,
      fileName: 'diagram.svg',
      mediaType: 'image/svg+xml',
      byteLength: svg.size,
      idempotencyKey: `web-mermaid-capture:${crypto.randomUUID()}`,
    }),
  );
  return (await fileResources.uploadAndCompleteFile(client, upload, svg)).itemId;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The publishable picture of `source`, sanitised and stamped. Throws when it cannot be drawn. */
export async function captureMermaidSvg(
  source: string,
  id: string,
  sourceSha256: string,
): Promise<string> {
  const { svg } = sanitizeSvg(await renderMermaid(source, id, true), sourceSha256);
  if (new TextEncoder().encode(svg).length > MAX_DIAGRAM_BYTES) {
    throw new Error('The diagram is too large to publish.');
  }
  return svg;
}

export interface CaptureTarget {
  readonly source: string;
  readonly renderFileId: string | null;
  readonly renderSourceHash: string | null;
  /** False for a read-only or locked editor. */
  readonly editable: boolean;
  /** Writes the attributes back, if the block still exists and may still be edited. */
  readonly commit: (renderFileId: string, renderSourceHash: string) => void;
}

/**
 * Captures the block's diagram after its source has been still for {@link CAPTURE_DELAY_MS},
 * when the source differs from what was last captured. A capture in flight always finishes and
 * records the hash of what it drew, so typing during an upload never orphans a file: the stale
 * hash simply triggers the next capture, into the same file.
 */
export function useMermaidCapture(target: CaptureTarget, id: string): void {
  const upload = useContext(MermaidCaptureContext);
  const busy = useRef(false);
  const { source, renderFileId, renderSourceHash, editable, commit } = target;
  const record = useEffectEvent(commit);

  useEffect(() => {
    if (upload === null || !editable || source.trim().length === 0) return;
    let waiting = true;
    const timer = setTimeout(() => {
      waiting = false;
      if (busy.current) return;
      busy.current = true;
      void (async () => {
        const digest = await sha256Hex(source);
        if (digest === renderSourceHash) return;
        const svg = await captureMermaidSvg(source, `nix-capture-${id}`, digest);
        const fileItemId = await upload(new Blob([svg], { type: 'image/svg+xml' }), renderFileId);
        record(fileItemId, digest);
      })()
        // A diagram that does not render, or an upload that fails, keeps publishing as code; the
        // next edit tries again.
        .catch(() => undefined)
        .finally(() => {
          busy.current = false;
        });
    }, CAPTURE_DELAY_MS);
    return () => {
      if (waiting) clearTimeout(timer);
    };
  }, [upload, editable, source, renderFileId, renderSourceHash, id]);
}
