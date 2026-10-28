import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  ARCHIVE_FORMAT,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ITEMS,
  MAX_TEMPLATE_ARCHIVE_ENTRIES,
  MAX_TEMPLATE_ARCHIVE_ITEMS,
  MANIFEST_ENTRY,
  isArchiveSafeId,
  fileVersionEntryName,
  itemEntryName,
  type ArchiveFileBytes,
  type ArchiveManifest,
  type ItemBundle,
} from './manifest.js';
import {
  assertBundleHasNoUnportableFiles,
  assertManifestHasNoUnportableFiles,
} from './file-portability.js';

/**
 * Writes a `.nix` archive as a stream of chunks.
 *
 * **The manifest is written first**, before any payload, so a reader has the tree before it has the
 * bodies. That is what lets a large archive be read without being held: a zip's central directory
 * is at the end, so an archive whose structure lived only there could not be streamed at all.
 *
 * **The caller supplies the manifest up front and the bundles lazily.** Enumerating the tree is
 * metadata-only and cheap; fetching bodies is neither. Separating them is what keeps this writer's
 * memory bounded by one item rather than by the size of the export - and it is why ADR-0017 puts
 * parentage and sibling order on the manifest spine rather than nesting children inside parents.
 *
 * **A failure part-way through truncates rather than completes.** Once the first byte is out there
 * is no status code left to change, so a bundle that cannot be produced ends the stream without the
 * central directory. The result does not open, which is the honest outcome - an archive that opens
 * and is quietly missing items would be a lie about the one property this format sells.
 */
export async function* writeArchive(input: {
  readonly manifest: ArchiveManifest;
  readonly bundles: AsyncIterable<ItemBundle>;
  /** Required in manifest order when v2 file descriptors are present. */
  readonly files?: AsyncIterable<ArchiveFileBytes>;
}): AsyncGenerator<Uint8Array> {
  const { manifest, bundles } = input;

  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(`An archive manifest must declare format '${ARCHIVE_FORMAT}'.`);
  }

  const templateProfile = manifest.profile !== undefined;
  const maxItems = templateProfile ? MAX_TEMPLATE_ARCHIVE_ITEMS : MAX_ARCHIVE_ITEMS;
  const maxEntries = templateProfile ? MAX_TEMPLATE_ARCHIVE_ENTRIES : MAX_ARCHIVE_ENTRIES;
  if (manifest.items.length < 1 || manifest.items.length > maxItems) {
    throw new Error(`A Nix archive must contain between 1 and ${String(maxItems)} items.`);
  }
  const entryCount = 1 + manifest.items.length + (manifest.files?.length ?? 0);
  if (entryCount > maxEntries) {
    throw new Error(`A Nix archive cannot contain more than ${String(maxEntries)} entries.`);
  }

  // Archive v1 has no file-byte entry. Check the manifest before constructing the zip so a file
  // item produces no plausible prefix at all; a later body reference still leaves the zip open.
  assertManifestHasNoUnportableFiles(manifest);

  // A holder rather than a bare `let`: the callback below assigns it, which the compiler cannot
  // see, so a plain variable would be narrowed to null at every read and the check would compile
  // to nothing.
  const state: { failure: Error | null } = { failure: null };
  const queue: Uint8Array[] = [];

  const zip = new Zip((error, chunk) => {
    if (error !== null) {
      state.failure = error;
      return;
    }

    if (chunk.length > 0) {
      queue.push(chunk);
    }
  });

  // Fixed ZIP metadata avoids time-zone and DST normalization; the manifest owns exportedAt.
  const mtime = new Date(1980, 0, 1);

  const expected = new Set(manifest.items.map((entry) => entry.id));
  const fileItemIds = new Set((manifest.files ?? []).map((entry) => entry.itemId));
  const written = new Set<string>();

  yield* addEntry(zip, queue, state, MANIFEST_ENTRY, encodeJson(manifest), mtime);

  for await (const bundle of bundles) {
    if (!isArchiveSafeId(bundle.id)) {
      throw new Error(`'${bundle.id}' is not a usable item identifier for an archive entry.`);
    }

    if (!expected.has(bundle.id)) {
      throw new Error(`The bundle for ${bundle.id} has no entry in the manifest.`);
    }

    if (written.has(bundle.id)) {
      throw new Error(`The bundle for ${bundle.id} was produced twice.`);
    }

    assertBundleHasNoUnportableFiles(bundle, manifest.formatVersion, fileItemIds);

    written.add(bundle.id);
    yield* addEntry(zip, queue, state, itemEntryName(bundle.id), encodeJson(bundle), mtime);
  }

  if (written.size !== expected.size) {
    // Deliberately before `zip.end()`, so the archive is never closed around a missing payload.
    throw new Error(
      `The manifest lists ${String(expected.size)} items but ${String(written.size)} were written. The archive would claim to be complete and would not be.`,
    );
  }

  const expectedFiles = manifest.files ?? [];
  let fileIndex = 0;
  if (input.files !== undefined) {
    for await (const file of input.files) {
      const descriptor = expectedFiles.at(fileIndex);
      if (descriptor?.itemId !== file.itemId || descriptor.version !== file.version) {
        throw new Error('The file bytes do not match the manifest file-version order.');
      }
      yield* addFileEntry(
        zip,
        queue,
        state,
        fileVersionEntryName(file.itemId, file.version),
        file.chunks,
        descriptor.byteLength,
        descriptor.sha256,
        mtime,
      );
      fileIndex += 1;
    }
  }
  if (fileIndex !== expectedFiles.length) {
    throw new Error(
      `The manifest lists ${String(expectedFiles.length)} file versions but ${String(fileIndex)} were written.`,
    );
  }
  zip.end();
  yield* drain(queue, state);
}

async function* addFileEntry(
  zip: Zip,
  queue: Uint8Array[],
  state: { failure: Error | null },
  name: string,
  chunks: AsyncIterable<Uint8Array>,
  expectedLength: number,
  expectedDigest: string,
  mtime: Date,
): AsyncGenerator<Uint8Array> {
  const entry = new ZipPassThrough(name);
  entry.mtime = mtime;
  zip.add(entry);
  const digest = sha256.create();
  let length = 0;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError(`File entry ${name} emitted a non-byte chunk.`);
    }
    length += chunk.byteLength;
    if (length > expectedLength) {
      throw new Error(`File entry ${name} exceeds its declared byte length.`);
    }
    digest.update(chunk);
    entry.push(chunk, false);
    yield* drain(queue, state);
  }
  if (length !== expectedLength) {
    throw new Error(`File entry ${name} has a different byte length than its manifest.`);
  }
  if (toHex(digest.digest()) !== expectedDigest) {
    throw new Error(`File entry ${name} has a different SHA-256 digest than its manifest.`);
  }
  entry.push(new Uint8Array(), true);
  yield* drain(queue, state);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Adds one entry and yields whatever the zip emitted for it. */
function* addEntry(
  zip: Zip,
  queue: Uint8Array[],
  state: { failure: Error | null },
  name: string,
  bytes: Uint8Array,
  mtime: Date,
): Generator<Uint8Array> {
  const entry = new ZipDeflate(name, { level: 6 });
  entry.mtime = mtime;

  zip.add(entry);

  // `ZipDeflate` compresses synchronously, so by the time push returns the archive's callback has
  // already run and the queue holds this entry's bytes. Nothing here waits on a worker.
  entry.push(bytes, true);

  yield* drain(queue, state);
}

/** Hands over whatever the zip has produced so far, newest failure first. */
function* drain(queue: Uint8Array[], state: { failure: Error | null }): Generator<Uint8Array> {
  if (state.failure !== null) {
    throw state.failure;
  }

  // Spliced rather than iterated and cleared: the callback can append while this runs, and taking
  // the buffer wholesale means a chunk arriving mid-drain is carried to the next one rather than
  // dropped.
  const chunks = queue.splice(0, queue.length);
  for (const chunk of chunks) {
    yield chunk;
  }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * A file name for an exported item, in the given format.
 *
 * Punctuation a file system argues about is replaced rather than stripped, so two items whose
 * titles differ only in it do not collapse to the same name. An item titled only in punctuation
 * falls back to a fixed name instead of producing a dotfile or an empty one.
 *
 * The extension carries no dot - it comes from a converter's `extension`, which does not carry one
 * either - and a leading dot is stripped rather than trusted, because a convention that is
 * documented and unenforced is one that produces `report..pdf` the first time somebody follows the
 * shape of the argument instead of the sentence describing it.
 */
export function exportFileName(title: string, extension: string): string {
  const slug = title
    .normalize('NFKD')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();

  return `${slug === '' ? 'export' : slug}.${extension.replace(/^\.+/, '')}`;
}
