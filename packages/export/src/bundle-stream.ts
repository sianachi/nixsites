import { ARCHIVE_FORMAT, type ArchiveManifest, type ItemBundle } from './manifest.js';

/**
 * Reads collab's bundle stream: the manifest on the first line, one bundle per line, then the
 * `{"end":true,"items":N}` sentinel (see `apps/collab/src/export/ndjson.ts`).
 *
 * **A stream without its sentinel is refused.** A truncated NDJSON stream is still a run of valid
 * lines, so accepting one would publish a silently incomplete site. The count is checked against
 * the bundles read, and blank lines (a trailing newline) are skipped.
 *
 * Shapes are checked structurally, not deeply: the manifest must name the archive format and each
 * bundle must carry an id. A body is drawn later through `visitProse`, which tolerates anything.
 */

export class BundleStreamError extends Error {
  override readonly name = 'BundleStreamError';
}

export interface BundleStream {
  readonly manifest: ArchiveManifest;
  readonly bundles: readonly ItemBundle[];
}

/** Line-by-line state shared by the sync and async readers; one place holds every check. */
class BundleStreamParser {
  private manifest: ArchiveManifest | null = null;
  private count = 0;
  private ended = false;

  constructor(private readonly keep: (bundle: ItemBundle) => boolean) {}

  readonly bundles: ItemBundle[] = [];

  push(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) {
      return;
    }
    if (this.ended) {
      throw new BundleStreamError('The bundle stream continues after its end marker.');
    }

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new BundleStreamError('The bundle stream holds a line that is not JSON.');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BundleStreamError('The bundle stream holds a line that is not an object.');
    }
    const record = value as Record<string, unknown>;

    if (this.manifest === null) {
      if (record.format !== ARCHIVE_FORMAT || !Array.isArray(record.items)) {
        throw new BundleStreamError('The bundle stream does not start with an archive manifest.');
      }
      this.manifest = record as unknown as ArchiveManifest;
      return;
    }

    if (record.end === true) {
      if (record.items !== this.count) {
        throw new BundleStreamError(
          `The bundle stream says it holds ${String(record.items)} bundles but carried ${String(this.count)}.`,
        );
      }
      this.ended = true;
      return;
    }

    if (typeof record.id !== 'string') {
      throw new BundleStreamError('The bundle stream holds a bundle without an id.');
    }
    this.count += 1;
    const bundle = record as unknown as ItemBundle;
    if (this.keep(bundle)) {
      this.bundles.push(bundle);
    }
  }

  finish(): BundleStream {
    if (this.manifest === null) {
      throw new BundleStreamError('The bundle stream is empty.');
    }
    if (!this.ended) {
      throw new BundleStreamError('The bundle stream ended before its end marker.');
    }
    return { manifest: this.manifest, bundles: this.bundles };
  }
}

export function readBundleStream(lines: Iterable<string>): BundleStream {
  const parser = new BundleStreamParser(() => true);
  for (const raw of lines) {
    parser.push(raw);
  }
  return parser.finish();
}

/**
 * The same checks over an async line source. Only bundles `keep` accepts are retained, so a caller
 * that needs one page holds one bundle, while the count check still sees every bundle.
 */
export async function readBundleStreamAsync(
  lines: AsyncIterable<string>,
  keep: (bundle: ItemBundle) => boolean = () => true,
): Promise<BundleStream> {
  const parser = new BundleStreamParser(keep);
  for await (const raw of lines) {
    parser.push(raw);
  }
  return parser.finish();
}
