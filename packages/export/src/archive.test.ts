import { FIXTURE_DOCUMENT, SCHEMA_VERSION } from '@nix/editor-schema';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { collect } from './collect.test-helper.js';

import { exportFileName, writeArchive } from './archive.js';
import { ARCHIVE_FILE_BYTES_UNSUPPORTED } from './file-portability.js';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_ENTRY,
  FILE_ARCHIVE_FORMAT_VERSION,
  fileVersionEntryName,
  itemEntryName,
  type ArchiveFileBytes,
  type ArchiveManifest,
  type ItemBundle,
  type ProseBody,
} from './manifest.js';

const ROOT = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';

function bundle(id: string, overrides: Partial<ItemBundle> = {}): ItemBundle {
  return {
    id,
    parentId: id === ROOT ? null : ROOT,
    workspaceId: '33333333-3333-3333-3333-333333333333',
    type: 'note',
    title: id === ROOT ? 'Root' : 'Child',
    seq: '1',
    lifecycleState: 'active',
    createdAt: '2026-07-29T10:00:00Z',
    updatedAt: '2026-07-29T10:00:00Z',
    properties: {},
    schema: null,
    views: null,
    viewRows: [],
    viewRowsTruncated: false,
    body: { schemaVersion: SCHEMA_VERSION, prosemirror: FIXTURE_DOCUMENT },
    ...overrides,
  };
}

function manifest(ids: readonly string[]): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-07-29T10:00:00.000Z',
    root: ROOT,
    rootEffectiveSchema: null,
    includesDeleted: false,
    items: ids.map((id) => ({
      id,
      parentId: id === ROOT ? null : ROOT,
      seq: '1',
      title: id === ROOT ? 'Root' : 'Child',
      type: 'note',
    })),
    omitted: [],
    loss: [],
  };
}

// The writer takes an AsyncIterable because real bundles are read from the database one at a time.
// A test's are already in hand, so there is nothing here to await.
// eslint-disable-next-line @typescript-eslint/require-await -- see above
async function* streamOf(bundles: readonly ItemBundle[]): AsyncGenerator<ItemBundle> {
  for (const item of bundles) {
    yield item;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// eslint-disable-next-line @typescript-eslint/require-await -- async iterable is the writer's public streaming contract.
async function* chunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes.subarray(0, Math.min(3, bytes.byteLength));
  if (bytes.byteLength > 3) yield bytes.subarray(3);
}

// eslint-disable-next-line @typescript-eslint/require-await -- async iterable is the writer's public streaming contract.
async function* fileStream(files: readonly ArchiveFileBytes[]): AsyncGenerator<ArchiveFileBytes> {
  for (const file of files) yield file;
}

async function* byteStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield* chunks(bytes);
}

async function consumeInto(
  archive: AsyncIterable<Uint8Array>,
  chunks: Uint8Array[],
): Promise<void> {
  for await (const chunk of archive) chunks.push(chunk);
}

describe('writeArchive', () => {
  it('produces a zip holding the manifest and one payload per item', async () => {
    const bytes = await collect(
      writeArchive({
        manifest: manifest([ROOT, CHILD]),
        bundles: streamOf([bundle(ROOT), bundle(CHILD)]),
      }),
    );

    const entries = unzipSync(bytes);

    expect(Object.keys(entries).sort()).toEqual(
      [MANIFEST_ENTRY, itemEntryName(ROOT), itemEntryName(CHILD)].sort(),
    );
  });

  it('writes the manifest before any payload, so a reader has the tree first', async () => {
    const bytes = await collect(
      writeArchive({
        manifest: manifest([ROOT, CHILD]),
        bundles: streamOf([bundle(ROOT), bundle(CHILD)]),
      }),
    );

    // The local file headers appear in write order, so the first entry name in the byte stream is
    // the first entry written. Reading the central directory would not prove the ordering.
    const text = new TextDecoder().decode(bytes.slice(0, 400));
    expect(text.indexOf(MANIFEST_ENTRY)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(MANIFEST_ENTRY)).toBeLessThan(text.indexOf(`items/`));
  });

  it('round-trips a document body without touching it', async () => {
    const bytes = await collect(
      writeArchive({ manifest: manifest([ROOT]), bundles: streamOf([bundle(ROOT)]) }),
    );

    const entry = unzipSync(bytes)[itemEntryName(ROOT)];
    const decoded = JSON.parse(new TextDecoder().decode(entry)) as ItemBundle;
    const body = decoded.body as ProseBody | null;

    expect(body?.prosemirror).toEqual(FIXTURE_DOCUMENT);
    expect(body?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('writes and reads versioned PDF attachments with streamed bytes and history metadata', async () => {
    const first = new TextEncoder().encode('%PDF-1.4\nfirst revision');
    const current = new TextEncoder().encode('%PDF-1.7\ncurrent revision');
    const fileManifest: ArchiveManifest = {
      ...manifest([ROOT]),
      formatVersion: FILE_ARCHIVE_FORMAT_VERSION,
      items: [{ id: ROOT, parentId: null, seq: '1', title: 'Brief.pdf', type: 'file' }],
      files: [
        {
          itemId: ROOT,
          version: 1,
          current: false,
          fileName: 'Brief.pdf',
          mediaType: 'application/pdf',
          byteLength: first.length,
          sha256: sha256(first),
          previewable: true,
          pixelWidth: null,
          pixelHeight: null,
        },
        {
          itemId: ROOT,
          version: 2,
          current: true,
          fileName: 'Brief.pdf',
          mediaType: 'application/pdf',
          byteLength: current.length,
          sha256: sha256(current),
          previewable: true,
          pixelWidth: null,
          pixelHeight: null,
        },
      ],
    };
    const bytes = await collect(
      writeArchive({
        manifest: fileManifest,
        bundles: streamOf([bundle(ROOT, { type: 'file', title: 'Brief.pdf', body: null })]),
        files: fileStream([
          { itemId: ROOT, version: 1, chunks: byteStream(first) },
          { itemId: ROOT, version: 2, chunks: byteStream(current) },
        ]),
      }),
    );
    const entries = unzipSync(bytes);

    expect(Object.keys(entries).sort()).toEqual(
      [
        MANIFEST_ENTRY,
        itemEntryName(ROOT),
        fileVersionEntryName(ROOT, 1),
        fileVersionEntryName(ROOT, 2),
      ].sort(),
    );
    expect(Buffer.from(entries[fileVersionEntryName(ROOT, 1)] ?? [])).toEqual(Buffer.from(first));
    expect(Buffer.from(entries[fileVersionEntryName(ROOT, 2)] ?? [])).toEqual(Buffer.from(current));
  });

  it('refuses a streamed file whose length or digest does not match the manifest', async () => {
    const bytes = new TextEncoder().encode('the source bytes');
    const fileManifest: ArchiveManifest = {
      ...manifest([ROOT]),
      formatVersion: FILE_ARCHIVE_FORMAT_VERSION,
      items: [{ id: ROOT, parentId: null, seq: '1', title: 'source.bin', type: 'file' }],
      files: [
        {
          itemId: ROOT,
          version: 1,
          current: true,
          fileName: 'source.bin',
          mediaType: 'application/octet-stream',
          byteLength: bytes.length,
          sha256: sha256(bytes),
          previewable: false,
          pixelWidth: null,
          pixelHeight: null,
        },
      ],
    };
    const changed = new TextEncoder().encode('the source byte!');

    await expect(
      collect(
        writeArchive({
          manifest: fileManifest,
          bundles: streamOf([bundle(ROOT, { type: 'file', title: 'source.bin', body: null })]),
          files: fileStream([{ itemId: ROOT, version: 1, chunks: byteStream(changed) }]),
        }),
      ),
    ).rejects.toThrow(/different SHA-256 digest/);
  });

  it('records the schema version the bodies were written against', async () => {
    const bytes = await collect(
      writeArchive({ manifest: manifest([ROOT]), bundles: streamOf([bundle(ROOT)]) }),
    );

    const entry = unzipSync(bytes)[MANIFEST_ENTRY];
    const decoded = JSON.parse(new TextDecoder().decode(entry)) as ArchiveManifest;

    expect(decoded.schemaVersion).toBe(SCHEMA_VERSION);
    expect(decoded.formatVersion).toBe(ARCHIVE_FORMAT_VERSION);
  });

  it('is byte-identical for the same content, so an unchanged export does not churn', async () => {
    const once = await collect(
      writeArchive({ manifest: manifest([ROOT]), bundles: streamOf([bundle(ROOT)]) }),
    );
    const twice = await collect(
      writeArchive({ manifest: manifest([ROOT]), bundles: streamOf([bundle(ROOT)]) }),
    );

    expect(Buffer.from(once).equals(Buffer.from(twice))).toBe(true);
  });

  it('refuses to close an archive that is missing a payload the manifest promised', async () => {
    await expect(
      collect(
        writeArchive({ manifest: manifest([ROOT, CHILD]), bundles: streamOf([bundle(ROOT)]) }),
      ),
    ).rejects.toThrow(/would claim to be complete/);
  });

  it('refuses a bundle the manifest does not list', async () => {
    await expect(
      collect(writeArchive({ manifest: manifest([ROOT]), bundles: streamOf([bundle(CHILD)]) })),
    ).rejects.toThrow(/no entry in the manifest/);
  });

  it('refuses an identifier that could escape the entry it names', async () => {
    await expect(
      collect(
        writeArchive({
          manifest: {
            ...manifest([ROOT]),
            items: [
              { id: '../../etc/passwd', parentId: null, seq: '1', title: 'Root', type: 'note' },
            ],
          },
          bundles: streamOf([bundle('../../etc/passwd')]),
        }),
      ),
    ).rejects.toThrow(/not a usable item identifier/);
  });

  it('refuses a manifest that does not declare the format', async () => {
    await expect(
      collect(
        writeArchive({
          manifest: { ...manifest([ROOT]), format: 'something-else' },
          bundles: streamOf([bundle(ROOT)]),
        }),
      ),
    ).rejects.toThrow(/must declare format/);
  });

  it('refuses a file item before emitting any archive bytes', async () => {
    const chunks: Uint8Array[] = [];
    const withFile = manifest([ROOT]);

    await expect(
      consumeInto(
        writeArchive({
          manifest: {
            ...withFile,
            items: withFile.items.map((item) => ({ ...item, type: 'file' })),
          },
          bundles: streamOf([bundle(ROOT, { type: 'file', body: null })]),
        }),
        chunks,
      ),
    ).rejects.toMatchObject({ code: ARCHIVE_FILE_BYTES_UNSUPPORTED });

    expect(chunks).toEqual([]);
  });

  it('refuses a durable note image rather than completing an archive without its bytes', async () => {
    const chunks: Uint8Array[] = [];

    await expect(
      consumeInto(
        writeArchive({
          manifest: manifest([ROOT]),
          bundles: streamOf([
            bundle(ROOT, {
              body: {
                schemaVersion: SCHEMA_VERSION,
                prosemirror: {
                  type: 'doc',
                  content: [
                    { type: 'image', attrs: { src: '', fileItemId: CHILD, alt: 'Diagram' } },
                  ],
                },
              },
            }),
          ]),
        }),
        chunks,
      ),
    ).rejects.toMatchObject({ code: ARCHIVE_FILE_BYTES_UNSUPPORTED });

    expect(() => unzipSync(Buffer.concat(chunks))).toThrow();
  });

  it('refuses legacy note image references that still use the nix-file source scheme', async () => {
    await expect(
      collect(
        writeArchive({
          manifest: manifest([ROOT]),
          bundles: streamOf([
            bundle(ROOT, {
              body: {
                schemaVersion: SCHEMA_VERSION,
                prosemirror: {
                  type: 'doc',
                  content: [{ type: 'image', attrs: { src: `nix-file:${CHILD}` } }],
                },
              },
            }),
          ]),
        }),
      ),
    ).rejects.toMatchObject({ code: ARCHIVE_FILE_BYTES_UNSUPPORTED });
  });

  it.each([
    {
      name: 'canonical canvas marker',
      element: {
        type: 'image',
        customData: { nix: { kind: 'file', itemId: CHILD } },
      },
    },
    {
      name: 'transitional native-canvas field',
      element: { type: 'image', imageItemId: CHILD },
    },
  ])('refuses a durable canvas image carried by its $name', async ({ element }) => {
    const withCanvas = manifest([ROOT]);

    await expect(
      collect(
        writeArchive({
          manifest: {
            ...withCanvas,
            items: withCanvas.items.map((item) => ({ ...item, type: 'canvas' })),
          },
          bundles: streamOf([
            bundle(ROOT, {
              type: 'canvas',
              body: {
                schemaVersion: SCHEMA_VERSION,
                canvas: { elements: { image: element } },
              },
            }),
          ]),
        }),
      ),
    ).rejects.toMatchObject({ code: ARCHIVE_FILE_BYTES_UNSUPPORTED });
  });

  it('keeps ordinary remote note images exportable because their bytes are not Nix-owned', async () => {
    const bytes = await collect(
      writeArchive({
        manifest: manifest([ROOT]),
        bundles: streamOf([
          bundle(ROOT, {
            body: {
              schemaVersion: SCHEMA_VERSION,
              prosemirror: {
                type: 'doc',
                content: [{ type: 'image', attrs: { src: 'https://example.test/diagram.png' } }],
              },
            },
          }),
        ]),
      }),
    );

    expect(unzipSync(bytes)[itemEntryName(ROOT)]).toBeDefined();
  });
});

describe('exportFileName', () => {
  it('names the file after the item, in the format that was asked for', () => {
    expect(exportFileName('Quarterly Review', 'pdf')).toBe('quarterly-review.pdf');
    expect(exportFileName('Quarterly Review', 'docx')).toBe('quarterly-review.docx');
  });

  it('strips a leading dot rather than producing a double one', () => {
    expect(exportFileName('Quarterly Review', '.pdf')).toBe('quarterly-review.pdf');
  });

  it('keeps titles that differ only in punctuation apart', () => {
    expect(exportFileName('Q1/Q2', 'nix')).not.toBe(exportFileName('Q1Q2', 'nix'));
  });

  it('falls back rather than producing a dotfile', () => {
    expect(exportFileName('...', 'nix')).toBe('export.nix');
    expect(exportFileName('', 'nix')).toBe('export.nix');
  });
});
