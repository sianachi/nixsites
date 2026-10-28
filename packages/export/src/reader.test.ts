import { readFileSync } from 'node:fs';
import { BASE_SCHEMA_VERSION, FIXTURE_DOCUMENT, SCHEMA_VERSION } from '@nix/editor-schema';
import { createHash } from 'node:crypto';
import { SHEET_LIMITS, SHEET_SCHEMA_VERSION } from '@nix/sheet';
import { Zip, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { collect } from './collect.test-helper.js';

import { writeArchive } from './archive.js';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  FILE_ARCHIVE_FORMAT_VERSION,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM,
  MAX_ARCHIVE_ITEMS,
  MANIFEST_ENTRY,
  MAX_TEMPLATE_ARCHIVE_ENTRIES,
  MAX_TEMPLATE_ARCHIVE_ITEMS,
  TEMPLATE_PROFILE_VERSION,
  itemEntryName,
  fileVersionEntryName,
  type ArchiveManifest,
  type ItemBundle,
} from './manifest.js';
import {
  parseArchiveObject,
  readArchive,
  requireTemplateProfile,
  validateTemplateArchive,
} from './reader.js';

it('keeps Go and TypeScript Nix archive profiles aligned with the shared limits fixture', () => {
  const limits = JSON.parse(
    readFileSync(new URL('../../../fixtures/nix-archive-v2-limits.json', import.meta.url), 'utf8'),
  ) as {
    ordinary: { maxArchiveEntries: number; maxItems: number };
    template: { maxArchiveEntries: number; maxItems: number };
    maxFileVersionsPerItem: number;
  };
  expect(limits.ordinary).toEqual({
    maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
    maxItems: MAX_ARCHIVE_ITEMS,
  });
  expect(limits.template).toEqual({
    maxArchiveEntries: MAX_TEMPLATE_ARCHIVE_ENTRIES,
    maxItems: MAX_TEMPLATE_ARCHIVE_ITEMS,
  });
  expect(limits.maxFileVersionsPerItem).toBe(MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM);
});

const ROOT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';

function manifest(): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    profile: {
      kind: 'template',
      version: TEMPLATE_PROFILE_VERSION,
      key: 'team.project',
      name: 'Team project',
      description: 'A shared starting point.',
      includeBody: true,
      includeChildren: true,
    },
    exportedAt: '2026-08-16T12:00:00.000Z',
    root: ROOT,
    rootEffectiveSchema: null,
    includesDeleted: false,
    items: [
      { id: ROOT, parentId: null, seq: '1000', title: 'Project', type: 'note' },
      { id: CHILD, parentId: ROOT, seq: '1000', title: 'First task', type: 'note' },
    ],
    omitted: [],
    loss: [],
  };
}

function bundle(id: string): ItemBundle {
  const root = id === ROOT;
  return {
    id,
    parentId: root ? null : ROOT,
    workspaceId: WORKSPACE,
    type: 'note',
    title: root ? 'Project' : 'First task',
    seq: '1000',
    lifecycleState: 'active',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:00:00.000Z',
    properties: {},
    schema: null,
    views: root
      ? {
          default: 'responses',
          views: [
            {
              id: 'responses',
              name: 'Responses',
              kind: 'list',
              columns: ['status'],
              groupBy: null,
              groupOrder: [],
              dateProperty: null,
              sortBy: null,
              sortDescending: false,
              mode: null,
              coverProperty: null,
              endDateProperty: null,
              cardSize: null,
              filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
              companionViewId: 'form',
              companionPlacement: 'beside',
              interactiveForm: null,
            },
            {
              id: 'form',
              name: 'Intake',
              kind: 'interactive_form',
              columns: [],
              groupBy: null,
              groupOrder: [],
              dateProperty: null,
              sortBy: null,
              sortDescending: false,
              mode: null,
              coverProperty: null,
              endDateProperty: null,
              cardSize: null,
              filters: [],
              companionViewId: null,
              companionPlacement: null,
              interactiveForm: {
                pages: [
                  {
                    id: 'page',
                    title: 'Details',
                    description: null,
                    visibleWhen: [],
                    blocks: [
                      {
                        id: 'name',
                        kind: 'field',
                        propertyKey: 'name',
                        text: 'Name',
                        help: null,
                        required: false,
                        identityRole: null,
                        visibleWhen: [],
                      },
                    ],
                  },
                ],
                titleMode: 'generated',
                titleFieldBlockId: null,
                confirmationTitle: 'Thank you',
                confirmationMessage: 'Saved.',
              },
            },
          ],
        }
      : null,
    viewRows: [],
    viewRowsTruncated: false,
    body: null,
  };
}

function fileBundle(id: string, title = 'Brief.pdf'): ItemBundle {
  return { ...bundle(id), type: 'file', title, body: null };
}

function fileDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileArchive(bytes: Uint8Array, overrides: Record<string, unknown> = {}): ArchiveManifest {
  return {
    ...manifest(),
    formatVersion: FILE_ARCHIVE_FORMAT_VERSION,
    items: [{ id: ROOT, parentId: null, seq: '1000', title: 'Brief.pdf', type: 'file' }],
    files: [
      {
        itemId: ROOT,
        version: 1,
        current: true,
        fileName: 'Brief.pdf',
        mediaType: 'application/pdf',
        byteLength: bytes.byteLength,
        sha256: fileDigest(bytes),
        previewable: true,
        pixelWidth: null,
        pixelHeight: null,
      },
    ],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- the production writer consumes an async source.
async function* bundles(): AsyncGenerator<ItemBundle> {
  yield bundle(ROOT);
  yield bundle(CHILD);
}

// eslint-disable-next-line @typescript-eslint/require-await -- the reader contract is deliberately asynchronous.
async function* pieces(bytes: Uint8Array, size = 17): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

function zipEntries(entries: readonly { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const zip = new Zip((error, chunk, final) => {
      if (error !== null) {
        reject(error);
        return;
      }
      chunks.push(chunk);
      length += chunk.byteLength;
      if (final) {
        const joined = new Uint8Array(length);
        let offset = 0;
        for (const each of chunks) {
          joined.set(each, offset);
          offset += each.byteLength;
        }
        resolve(joined);
      }
    });
    for (const entry of entries) {
      const file = new ZipPassThrough(entry.name);
      zip.add(file);
      file.push(entry.bytes, true);
    }
    zip.end();
  });
}

describe('the hostile archive reader', () => {
  it('writes identical bytes across time zones even at a daylight-saving gap', async () => {
    const originalZone = process.env.TZ;
    const input = { ...manifest(), exportedAt: '2026-03-08T02:30:00.000Z' };
    try {
      process.env.TZ = 'UTC';
      const utc = await collect(writeArchive({ manifest: input, bundles: bundles() }));
      process.env.TZ = 'America/New_York';
      const daylightSavingGap = await collect(
        writeArchive({ manifest: input, bundles: bundles() }),
      );
      expect(daylightSavingGap).toEqual(utc);
    } finally {
      if (originalZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalZone;
    }
  });

  it('retains chat views, message text and conversation configuration in a native round trip', async () => {
    const original = bundle(ROOT);
    const firstView = original.views?.views[0];
    if (firstView === undefined) throw new Error('Expected fixture view');
    const config = JSON.stringify({ sourceWorkspaceIds: [WORKSPACE], petId: 'pet', revision: 1 });
    const parsed = parseArchiveObject({
      manifest: manifest(),
      bundles: [
        {
          ...original,
          properties: { $chat_config: config },
          views: { default: 'chat', views: [{ ...firstView, id: 'chat', kind: 'chat' }] },
        },
        {
          ...bundle(CHILD),
          properties: {
            chat_role: 'assistant',
            chat_text: 'Full message <&>\nSecond line',
            chat_created_at: '2026-10-15',
            chat_author: 'pet',
          },
        },
      ],
    });
    async function* messages() {
      for (const entry of parsed.bundles) yield await Promise.resolve(entry);
    }
    const restored = await readArchive(
      pieces(await collect(writeArchive({ manifest: manifest(), bundles: messages() }))),
    );
    expect(restored.bundles).toEqual(parsed.bundles);
    expect(parsed.bundles[0]?.views?.views[0]?.kind).toBe('chat');
    expect(parsed.bundles[0]?.properties.$chat_config).toBe(config);
    expect(parsed.bundles[1]?.properties.chat_text).toBe('Full message <&>\nSecond line');
  });
  it('preserves item recurrence metadata through expanded service payloads', () => {
    const recurrence = { frequency: 'weekly', interval: 2, daysOfWeek: ['monday'] };
    const parsed = parseArchiveObject({
      manifest: manifest(),
      bundles: [{ ...bundle(ROOT), recurrence }, bundle(CHILD)],
    });

    expect(parsed.bundles[0]?.recurrence).toEqual(recurrence);
  });

  it('parses the expanded service object with the same nested and cross-entry rules', () => {
    const parsed = parseArchiveObject({
      manifest: manifest(),
      bundles: [bundle(ROOT), bundle(CHILD)],
    });

    expect(parsed.bundles.map((entry) => entry.id)).toEqual([ROOT, CHILD]);
    expect(parsed.bundles[0]?.views?.views[1]?.interactiveForm?.pages[0]?.blocks[0]).toMatchObject({
      id: 'name',
      propertyKey: 'name',
    });
  });

  it('refuses malformed nested service objects rather than trusting their archive annotation', () => {
    const malformed = {
      ...bundle(ROOT),
      views: {
        ...bundle(ROOT).views,
        views: [
          {
            id: 'form',
            name: 'Form',
            kind: 'interactive_form',
            columns: [],
            groupOrder: [],
            sortDescending: false,
            interactiveForm: { pages: 'not-pages' },
          },
        ],
      },
    };

    expect(() =>
      parseArchiveObject({ manifest: manifest(), bundles: [malformed, bundle(CHILD)] }),
    ).toThrowError(expect.objectContaining({ code: 'archive.form_invalid' }) as Error);
  });

  it('refuses expanded service objects whose payloads disagree with the manifest', () => {
    expect(() =>
      parseArchiveObject({
        manifest: manifest(),
        bundles: [{ ...bundle(ROOT), title: 'Different' }, bundle(CHILD)],
      }),
    ).toThrowError(expect.objectContaining({ code: 'archive.bundle_mismatch' }) as Error);
  });

  it('accepts a schema carrying every property type the server defines', () => {
    // The server's closed set, spelled out (`PropertyType.cs` / `PropertyTypes.TryParse` is the
    // canon). This reader is a validator that refuses what it does not know, so a type added to
    // the canon and not to its mirror breaks the archive round trip for exactly the schemas that
    // carry it - which is how the five task types shipped un-importable until this test existed.
    // A new type must appear here AND in the reader's set, deliberately: the failure is loud.
    const everyType = [
      'text',
      'long_text',
      'number',
      'select',
      'multi_select',
      'date',
      'checkbox',
      'url',
      'timestamp',
      'image',
      'due_date',
      'start_date',
      'completion',
      'priority',
      'estimate',
      'assignee',
      'formula',
      'rollup',
      'datetime',
      'reminder',
    ];

    const properties = everyType.map((type) => ({
      key: type,
      label: type,
      type,
      options: type === 'select' || type === 'multi_select' ? ['One'] : [],
      required: false,
      ...(type === 'formula' ? { expression: '1 + 1' } : {}),
      ...(type === 'rollup' ? { aggregate: 'count', source: null } : {}),
    }));

    const read = parseArchiveObject({
      manifest: manifest(),
      bundles: [
        { ...bundle(ROOT), schema: { properties, declared: properties, inherit: true } },
        bundle(CHILD),
      ],
    });

    expect(read.bundles[0]?.schema?.properties.map((property) => property.type)).toEqual(everyType);
  });

  it('preserves dynamic choice sources and refuses malformed sources', () => {
    const field = {
      key: 'who',
      label: 'Who',
      type: 'multi_select',
      options: [],
      required: false,
      choiceSource: { itemId: '11111111-1111-4111-8111-111111111111', field: 'title' },
    };
    const read = (property: unknown) =>
      parseArchiveObject({
        manifest: manifest(),
        bundles: [
          {
            ...bundle(ROOT),
            schema: { properties: [property], declared: [property], inherit: true },
          },
          bundle(CHILD),
        ],
      });
    expect(read(field).bundles[0]?.schema?.properties[0]?.choiceSource).toEqual(field.choiceSource);
    expect(() =>
      read({ ...field, choiceSource: { ...field.choiceSource, field: '$inside' } }),
    ).toThrow('invalid choice source');
  });

  it.each([ARCHIVE_FORMAT_VERSION, FILE_ARCHIVE_FORMAT_VERSION])(
    'preserves computed definitions in an archive v%s round trip',
    async (formatVersion) => {
      const properties = [
        {
          key: 'amount',
          label: 'Amount',
          type: 'number',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
        },
        {
          key: 'completion',
          label: 'Completed',
          type: 'completion',
          options: [],
          required: false,
        },
        {
          key: 'total',
          label: 'Total',
          type: 'formula',
          options: [],
          required: false,
          expression: '[amount] * 2',
          aggregate: null,
          source: null,
        },
        ...['count', 'sum', 'min', 'max', 'average', 'any', 'all'].map((aggregate) => ({
          key: `rollup_${aggregate}`,
          label: aggregate,
          type: 'rollup',
          options: [],
          required: false,
          expression: null,
          aggregate,
          source:
            aggregate === 'count'
              ? null
              : aggregate === 'any' || aggregate === 'all'
                ? 'completion'
                : 'amount',
        })),
        {
          key: 'long_source',
          label: 'Long source',
          type: 'rollup',
          options: [],
          required: false,
          aggregate: 'sum',
          source: 'a'.repeat(201),
        },
      ];
      const schema = { properties, declared: properties.slice(2), inherit: true };
      const snapshot = {
        ...manifest(),
        formatVersion,
        rootEffectiveSchema: schema,
        ...(formatVersion === FILE_ARCHIVE_FORMAT_VERSION ? { files: [] } : {}),
      };
      // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer consumes an async source.
      async function* source(): AsyncGenerator<ItemBundle> {
        yield { ...bundle(ROOT), schema };
        yield bundle(CHILD);
      }

      const bytes = await collect(writeArchive({ manifest: snapshot, bundles: source() }));
      const read = await readArchive(pieces(bytes));

      expect(read.manifest.rootEffectiveSchema).toEqual(schema);
      expect(read.bundles[0]?.schema).toEqual(schema);
      expect(read.bundles[1]?.schema).toBeNull();
    },
  );

  it('preserves older property definitions without introducing computed metadata', () => {
    const property = { key: 'name', label: 'Name', type: 'text', options: [], required: false };
    const schema = { properties: [property], declared: [property], inherit: false };
    const read = parseArchiveObject({
      manifest: manifest(),
      bundles: [{ ...bundle(ROOT), schema }, bundle(CHILD)],
    });

    expect(read.bundles[0]?.schema).toEqual(schema);
  });

  it.each([
    { type: 'formula' },
    { type: 'formula', expression: null },
    { type: 'formula', expression: ' ' },
    { type: 'formula', expression: 7 },
    { type: 'formula', expression: '1'.repeat(1_025) },
    { type: 'formula', expression: '1', required: true },
    { type: 'formula', expression: '1', options: ['One'] },
    { type: 'formula', expression: '1', aggregate: 'count' },
    { type: 'formula', expression: '1', source: 'amount' },
    { type: 'rollup' },
    { type: 'rollup', aggregate: null },
    { type: 'rollup', aggregate: 7 },
    { type: 'rollup', aggregate: 'median' },
    { type: 'rollup', aggregate: 'sum' },
    { type: 'rollup', aggregate: 'sum', source: null },
    { type: 'rollup', aggregate: 'sum', source: '' },
    { type: 'rollup', aggregate: 'sum', source: 7 },
    { type: 'rollup', aggregate: 'sum', source: 'computed' },
    { type: 'rollup', aggregate: 'count', expression: '1' },
    { type: 'rollup', aggregate: 'count', required: true },
    { type: 'rollup', aggregate: 'count', options: ['One'] },
    { type: 'text', expression: '1' },
    { type: 'text', aggregate: 'count' },
    { type: 'text', source: 'amount' },
  ])('refuses malformed computed metadata case %#', (metadata) => {
    const property = {
      key: 'computed',
      label: 'Computed',
      options: [],
      required: false,
      ...metadata,
    };
    const schema = { properties: [property], declared: [property], inherit: true };
    expect(() =>
      parseArchiveObject({
        manifest: manifest(),
        bundles: [{ ...bundle(ROOT), schema }, bundle(CHILD)],
      }),
    ).toThrowError(expect.objectContaining({ code: 'archive.schema_invalid' }) as Error);
    expect(() =>
      parseArchiveObject({
        manifest: { ...manifest(), rootEffectiveSchema: schema },
        bundles: [bundle(ROOT), bundle(CHILD)],
      }),
    ).toThrowError(expect.objectContaining({ code: 'archive.schema_invalid' }) as Error);
  });

  it('reads a chunked template archive and preserves modern view configuration', async () => {
    const bytes = await collect(writeArchive({ manifest: manifest(), bundles: bundles() }));
    const read = await readArchive(pieces(bytes));
    const profile = validateTemplateArchive(read);

    expect(profile.key).toBe('team.project');
    expect(read.bundles).toHaveLength(2);
    expect(read.bundles[0]?.views?.views[0]).toMatchObject({
      filters: [{ property: 'status', operator: 'equals', value: 'Open' }],
      companionViewId: 'form',
      companionPlacement: 'beside',
    });
  });

  it('allows body-bearing descendants when only the root body was excluded', async () => {
    const childBody: ItemBundle = {
      ...bundle(CHILD),
      body: {
        schemaVersion: SCHEMA_VERSION,
        prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    };
    const current = manifest();
    if (current.profile === undefined)
      throw new Error('The fixture must contain a template profile.');
    const rootExcluded: ArchiveManifest = {
      ...current,
      profile: { ...current.profile, includeBody: false },
    };
    // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer consumes an async source.
    async function* selectedBundles(): AsyncGenerator<ItemBundle> {
      yield bundle(ROOT);
      yield childBody;
    }
    const bytes = await collect(
      writeArchive({ manifest: rootExcluded, bundles: selectedBundles() }),
    );
    const read = await readArchive(pieces(bytes));

    expect(validateTemplateArchive(read).includeBody).toBe(false);
    expect(read.bundles[1]?.body).not.toBeNull();
  });

  it('refuses a root body when the profile says the root body was excluded', async () => {
    const current = manifest();
    if (current.profile === undefined)
      throw new Error('The fixture must contain a template profile.');
    const rootExcluded: ArchiveManifest = {
      ...current,
      profile: { ...current.profile, includeBody: false },
    };
    const rootWithBody: ItemBundle = {
      ...bundle(ROOT),
      body: {
        schemaVersion: SCHEMA_VERSION,
        prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    };
    // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer consumes an async source.
    async function* selectedBundles(): AsyncGenerator<ItemBundle> {
      yield rootWithBody;
      yield bundle(CHILD);
    }
    const bytes = await collect(
      writeArchive({ manifest: rootExcluded, bundles: selectedBundles() }),
    );
    const read = await readArchive(pieces(bytes));

    expect(() => validateTemplateArchive(read)).toThrowError(
      expect.objectContaining({ code: 'template.body_mismatch' }) as Error,
    );
  });

  it('refuses a path traversal before reading its payload', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest())),
      '../template.json': strToU8('{}'),
    });

    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.invalid_entry_name',
    });
  });

  it('round-trips v2 file entries and accepts previewable PDFs without raster dimensions', async () => {
    const body = strToU8('%PDF-1.7\nA small attachment.');
    const archive = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(fileArchive(body))),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(fileBundle(ROOT))),
      [fileVersionEntryName(ROOT, 1)]: body,
    });

    const read = await readArchive(pieces(archive));

    expect(read.manifest.formatVersion).toBe(FILE_ARCHIVE_FORMAT_VERSION);
    expect(read.files).toHaveLength(1);
    expect(read.files[0]?.descriptor.previewable).toBe(true);
    expect(read.files[0]?.descriptor.pixelWidth).toBeNull();
    expect(Buffer.from(read.files[0]?.bytes ?? [])).toEqual(Buffer.from(body));
  });

  it('reads the shared TypeScript-authored v2 PDF history fixture', async () => {
    const bytes = readFileSync(
      new URL('../../../fixtures/nix-archive-v2-file.nix', import.meta.url),
    );
    const read = await readArchive(pieces(bytes));

    expect(read.manifest.formatVersion).toBe(FILE_ARCHIVE_FORMAT_VERSION);
    expect(read.files.map((entry) => entry.descriptor.version)).toEqual([1, 2]);
    expect(read.files.map((entry) => Buffer.from(entry.bytes).toString())).toEqual([
      '%PDF-1.5\nold version',
      '%PDF-1.5\ncurrent version',
    ]);
  });

  it('rejects file bytes whose digest differs from the v2 manifest', async () => {
    const actual = strToU8('%PDF-1.7\nActual bytes');
    const expected = strToU8('%PDF-1.7\nOther bytes!');
    const archive = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(fileArchive(expected))),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(fileBundle(ROOT))),
      [fileVersionEntryName(ROOT, 1)]: actual,
    });

    await expect(readArchive(pieces(archive))).rejects.toMatchObject({
      code: 'archive.file_digest_mismatch',
    });
  });

  it('rejects a v2 archive with an unlisted file entry', async () => {
    const body = strToU8('%PDF-1.7\nA small attachment.');
    const archive = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(fileArchive(body))),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(fileBundle(ROOT))),
      [fileVersionEntryName(ROOT, 1)]: body,
      [fileVersionEntryName(ROOT, 2)]: body,
    });

    await expect(readArchive(pieces(archive))).rejects.toMatchObject({
      code: 'archive.file_entry_mismatch',
    });
  });

  it('rejects hostile file entry names before extracting their payload', async () => {
    const body = strToU8('%PDF-1.7\nA small attachment.');
    const archive = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(fileArchive(body))),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(fileBundle(ROOT))),
      'files/../outside/1.bin': body,
    });

    await expect(readArchive(pieces(archive))).rejects.toMatchObject({
      code: 'archive.invalid_entry_name',
    });
  });

  it('keeps v1 readable but rejects a file item that v1 cannot carry', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(
        JSON.stringify({ ...manifest(), items: [{ ...manifest().items[0], type: 'file' }] }),
      ),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(fileBundle(ROOT))),
    });

    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.file_bytes_unsupported',
    });
  });

  it('refuses an entry whose expanded bytes cross the per-entry bound', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest())),
      [itemEntryName(ROOT)]: new Uint8Array(2048),
    });

    await expect(
      readArchive(pieces(bytes), {
        limits: {
          maxInputBytes: 4096,
          maxEntryBytes: 1024,
          maxUncompressedBytes: 4096,
          maxEntries: 3,
          maxItems: 2,
          maxCompressionRatio: 100,
        },
      }),
    ).rejects.toMatchObject({ code: 'archive.entry_too_large' });
  });

  it('refuses a manifest that promises a payload the zip never supplies', async () => {
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest())) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.bundle_missing',
    });
  });

  it('refuses an ordinary archive at the template boundary without rejecting archive v1 itself', async () => {
    const ordinary = { ...manifest() };
    delete ordinary.profile;
    const bytes = await collect(writeArchive({ manifest: ordinary, bundles: bundles() }));
    const read = await readArchive(pieces(bytes));

    expect(() => requireTemplateProfile(read.manifest)).toThrowError('it is not a template file');
  });

  it('refuses template profile text outside the persisted catalog bounds', async () => {
    const invalid = {
      ...manifest(),
      profile: { ...manifest().profile, description: 'x'.repeat(1001) },
    };
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalid)) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'template.profile_invalid',
    });
  });

  it('preserves the versioned initialization profile and refuses rules outside the template tree', async () => {
    const baseManifest = manifest();
    if (baseManifest.profile === undefined) throw new Error('The fixture must contain a profile.');
    const initialized: ArchiveManifest = {
      ...baseManifest,
      profile: {
        ...baseManifest.profile,
        initialization: {
          version: 1 as const,
          inputs: [
            { key: 'project_name', label: 'Project name', type: 'text' as const, required: true },
          ],
          rules: [
            {
              sourceId: ROOT,
              propertyKey: 'name',
              kind: 'input' as const,
              inputKey: 'project_name',
            },
          ],
          references: [{ sourceItemId: WORKSPACE, policy: 'omit' as const }],
        },
      },
    };
    const bytes = await collect(
      writeArchive({
        manifest: initialized,
        bundles: bundles(),
      }),
    );
    const archive = await readArchive(pieces(bytes));
    const profile = validateTemplateArchive(archive);

    expect(profile.initialization?.rules[0]?.sourceId).toBe(ROOT);
    expect(profile.initialization?.references[0]?.policy).toBe('omit');

    const initialization = profile.initialization;
    if (initialization == null)
      throw new Error('The fixture must preserve initialization metadata.');
    const outsideTree = {
      ...archive,
      manifest: {
        ...archive.manifest,
        profile: {
          ...profile,
          initialization: {
            ...initialization,
            rules: [
              {
                sourceId: WORKSPACE,
                propertyKey: 'name',
                kind: 'input' as const,
                inputKey: 'project_name',
              },
            ],
          },
        },
      },
    };
    expect(() => validateTemplateArchive(outsideTree)).toThrowError(
      expect.objectContaining({ code: 'template.initialization_invalid' }) as Error,
    );
  });

  it('refuses unknown initialization keys instead of silently dropping profile data', async () => {
    const invalid = {
      ...manifest(),
      profile: {
        ...manifest().profile,
        initialization: { version: 1, inputs: [], rules: [], references: [], undeclared: true },
      },
    };
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalid)) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'template.initialization_invalid',
    });
  });

  it('refuses a duplicate zip entry', async () => {
    const encoded = strToU8(JSON.stringify(manifest()));
    const bytes = await zipEntries([
      { name: MANIFEST_ENTRY, bytes: encoded },
      { name: MANIFEST_ENTRY, bytes: encoded },
    ]);
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.duplicate_entry',
    });
  });

  it('refuses malformed JSON before treating it as a manifest', async () => {
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8('{not-json') });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.invalid_json',
    });
  });

  it('refuses a document schema newer than this build', async () => {
    const future = { ...manifest(), schemaVersion: Number.MAX_SAFE_INTEGER };
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(future)) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.schema_unsupported',
    });
  });

  it('refuses a document schema older than this build can interpret', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify({ ...manifest(), schemaVersion: 0 })),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.schema_unsupported',
    });
  });

  it('refuses an unsupported archive vocabulary', async () => {
    const invalid = { ...manifest(), format: 'another-archive' };
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalid)) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.invalid_manifest',
    });
  });

  it('refuses unsupported view vocabulary inside an item bundle', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const current = bundle(ROOT);
    const firstView = current.views?.views[0];
    if (firstView === undefined) throw new Error('The fixture must contain a view.');
    const invalid: ItemBundle = {
      ...current,
      views: {
        default: 'future',
        views: [{ ...firstView, id: 'future', kind: 'future_view' }],
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.views_invalid',
    });
  });

  it('refuses a non-canonical item identifier', async () => {
    const invalid = { ...manifest(), root: '1'.repeat(36) };
    const bytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalid)) });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.invalid_manifest',
    });
  });

  it('refuses a malformed identifier in an item entry name', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest())),
      'items/------------------------------------.json': strToU8(JSON.stringify(bundle(ROOT))),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.invalid_entry_name',
    });
  });

  it('refuses a bundle whose identifier differs from its entry name', async () => {
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(manifest())),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify({ ...bundle(ROOT), id: CHILD })),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.bundle_mismatch',
    });
  });

  it('refuses non-boolean deleted-item metadata and unsupported omission vocabulary', async () => {
    const invalidBoolean = { ...manifest(), includesDeleted: 'no' };
    const booleanBytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalidBoolean)) });
    await expect(readArchive(pieces(booleanBytes))).rejects.toMatchObject({
      code: 'archive.invalid_manifest',
    });

    const invalidOmission = {
      ...manifest(),
      omitted: [{ id: null, parentId: ROOT, reason: 'secret', detail: 'Not included.' }],
    };
    const omissionBytes = zipSync({ [MANIFEST_ENTRY]: strToU8(JSON.stringify(invalidOmission)) });
    await expect(readArchive(pieces(omissionBytes))).rejects.toMatchObject({
      code: 'archive.invalid_manifest',
    });
  });

  it('refuses unsupported filter vocabulary inside a view', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const current = bundle(ROOT);
    const firstView = current.views?.views[0];
    if (firstView === undefined) throw new Error('The fixture must contain a view.');
    const invalid = {
      ...current,
      views: {
        default: firstView.id,
        views: [
          { ...firstView, filters: [{ property: 'status', operator: 'execute', value: 'x' }] },
        ],
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.views_invalid',
    });
  });

  it('refuses malformed nested body data as an archive error', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const invalid = { ...bundle(ROOT), body: { schemaVersion: 2, prosemirror: 'not-an-object' } };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });
  });

  it('refuses ProseMirror JSON outside the supported editor schema', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const invalid = {
      ...bundle(ROOT),
      body: { schemaVersion: SCHEMA_VERSION, prosemirror: { type: 'unknown-document' } },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });
  });

  it('refuses a body schema newer than its manifest declaration', async () => {
    const one = {
      ...manifest(),
      schemaVersion: SCHEMA_VERSION - 1,
      items: manifest().items.slice(0, 1),
    };
    const invalid = {
      ...bundle(ROOT),
      body: {
        schemaVersion: SCHEMA_VERSION,
        prosemirror: { type: 'doc', content: [{ type: 'paragraph' }] },
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    const read = await readArchive(pieces(bytes));
    expect(() => validateTemplateArchive(read)).toThrowError(
      expect.objectContaining({ code: 'template.body_schema_mismatch' }) as Error,
    );
  });

  it('refuses a ProseMirror body pinned below the nodes it contains', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const invalid = {
      ...bundle(ROOT),
      body: { schemaVersion: BASE_SCHEMA_VERSION, prosemirror: FIXTURE_DOCUMENT },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });
  });

  it('refuses malformed and over-limit spreadsheet snapshots before staging', async () => {
    const rootEntry = manifest().items[0];
    if (rootEntry === undefined) throw new Error('The fixture must contain a root item.');
    const sheetManifest = {
      ...manifest(),
      items: [{ ...rootEntry, type: 'spreadsheet' }],
    };
    const malformed = {
      ...bundle(ROOT),
      type: 'spreadsheet',
      body: {
        schemaVersion: SHEET_SCHEMA_VERSION,
        sheet: {
          body: 'sheet',
          cells: { a1: 'value' },
          meta: { rows: 100, cols: 26, colWidths: {} },
        },
      },
    };
    const malformedBytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(sheetManifest)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(malformed)),
    });
    await expect(readArchive(pieces(malformedBytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });

    const overLimit = {
      ...malformed,
      body: {
        schemaVersion: SHEET_SCHEMA_VERSION,
        sheet: {
          body: 'sheet',
          cells: { A1: 'value' },
          meta: { rows: SHEET_LIMITS.maxRows + 1, cols: 26, colWidths: {} },
        },
      },
    };
    const overLimitBytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(sheetManifest)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(overLimit)),
    });
    await expect(readArchive(pieces(overLimitBytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });
  });

  it('refuses malformed and over-limit canvas scenes before staging', async () => {
    const rootEntry = manifest().items[0];
    if (rootEntry === undefined) throw new Error('The fixture must contain a root item.');
    const canvasManifest = {
      ...manifest(),
      items: [{ ...rootEntry, type: 'canvas' }],
    };
    const malformed = {
      ...bundle(ROOT),
      type: 'canvas',
      body: {
        schemaVersion: BASE_SCHEMA_VERSION,
        canvas: {
          elements: { element: { id: 'other', type: 'rectangle', version: 1, versionNonce: 1 } },
        },
      },
    };
    const malformedBytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(canvasManifest)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(malformed)),
    });
    await expect(readArchive(pieces(malformedBytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });

    for (const element of [
      { id: 'element', type: 'rectangle', version: 1.5, versionNonce: 1 },
      { id: 'element', type: 'rectangle', version: 1, versionNonce: -1 },
    ]) {
      const invalidReconciliationBytes = zipSync({
        [MANIFEST_ENTRY]: strToU8(JSON.stringify(canvasManifest)),
        [itemEntryName(ROOT)]: strToU8(
          JSON.stringify({
            ...malformed,
            body: {
              schemaVersion: BASE_SCHEMA_VERSION,
              canvas: { elements: { element } },
            },
          }),
        ),
      });
      await expect(readArchive(pieces(invalidReconciliationBytes))).rejects.toMatchObject({
        code: 'archive.body_invalid',
      });
    }

    const elements = Object.fromEntries(
      Array.from({ length: 10_001 }, (_unused, index) => {
        const id = `element-${String(index)}`;
        return [id, { id, type: 'rectangle', version: 1, versionNonce: index }];
      }),
    );
    const overLimitBytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(canvasManifest)),
      [itemEntryName(ROOT)]: strToU8(
        JSON.stringify({
          ...malformed,
          body: { schemaVersion: BASE_SCHEMA_VERSION, canvas: { elements } },
        }),
      ),
    });
    await expect(readArchive(pieces(overLimitBytes))).rejects.toMatchObject({
      code: 'archive.body_invalid',
    });
  });

  it('refuses malformed nested interactive form data as an archive error', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const invalid = {
      ...bundle(ROOT),
      views: {
        default: 'form',
        views: [
          {
            id: 'form',
            name: 'Form',
            kind: 'interactive_form',
            columns: [],
            groupBy: null,
            groupOrder: [],
            dateProperty: null,
            sortBy: null,
            sortDescending: false,
            mode: null,
            coverProperty: null,
            endDateProperty: null,
            cardSize: null,
            interactiveForm: {
              pages: [{ id: 'page', title: 'Page', blocks: 'not-an-array' }],
              titleMode: 'generated',
              titleFieldBlockId: null,
              confirmationTitle: 'Thanks',
              confirmationMessage: 'Saved',
            },
          },
        ],
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.form_invalid',
    });
  });

  it('refuses unsupported interactive form vocabulary', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const invalid = {
      ...bundle(ROOT),
      views: {
        default: 'form',
        views: [
          {
            id: 'form',
            name: 'Form',
            kind: 'interactive_form',
            columns: [],
            groupBy: null,
            groupOrder: [],
            dateProperty: null,
            sortBy: null,
            sortDescending: false,
            mode: null,
            coverProperty: null,
            endDateProperty: null,
            cardSize: null,
            interactiveForm: {
              pages: [
                {
                  id: 'page',
                  title: 'Page',
                  visibleWhen: [],
                  blocks: [
                    {
                      id: 'question',
                      kind: 'script',
                      propertyKey: 'name',
                      text: 'Name',
                      help: null,
                      required: true,
                      identityRole: 'administrator',
                      visibleWhen: [],
                    },
                  ],
                },
              ],
              titleMode: 'calculated',
              titleFieldBlockId: null,
              confirmationTitle: 'Thanks',
              confirmationMessage: 'Saved',
            },
          },
        ],
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.form_invalid',
    });
  });

  it('refuses semantic interactive form errors before staging', async () => {
    const one = { ...manifest(), items: manifest().items.slice(0, 1) };
    const current = bundle(ROOT);
    const formView = current.views?.views[1];
    if (formView?.interactiveForm == null) throw new Error('The fixture must contain a form.');
    const invalid = {
      ...current,
      views: {
        default: formView.id,
        views: [
          {
            ...formView,
            interactiveForm: {
              ...formView.interactiveForm,
              pages: [
                {
                  id: 'page',
                  title: 'Page',
                  description: null,
                  visibleWhen: [],
                  blocks: [
                    {
                      id: 'heading',
                      kind: 'heading',
                      propertyKey: null,
                      text: 'Heading',
                      help: null,
                      required: false,
                      identityRole: null,
                      visibleWhen: [],
                    },
                    {
                      id: 'later',
                      kind: 'field',
                      propertyKey: 'later',
                      text: 'Later',
                      help: null,
                      required: false,
                      identityRole: null,
                      visibleWhen: [{ fieldBlockId: 'missing', operator: 'equals', value: 'yes' }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    };
    const bytes = zipSync({
      [MANIFEST_ENTRY]: strToU8(JSON.stringify(one)),
      [itemEntryName(ROOT)]: strToU8(JSON.stringify(invalid)),
    });
    const read = await readArchive(pieces(bytes));
    expect(() => validateTemplateArchive(read)).toThrowError(
      expect.objectContaining({ code: 'template.form_invalid' }) as Error,
    );
  });

  it('refuses when expanded entries cross the archive total', async () => {
    const bytes = await collect(writeArchive({ manifest: manifest(), bundles: bundles() }));
    await expect(
      readArchive(pieces(bytes), {
        limits: {
          maxInputBytes: 64 * 1024,
          maxEntryBytes: 8 * 1024,
          maxUncompressedBytes: 1500,
          maxEntries: 3,
          maxItems: 2,
          maxCompressionRatio: 100,
        },
      }),
    ).rejects.toMatchObject({ code: 'archive.too_large' });
  });

  it('refuses an archive that expands past the compression ratio', async () => {
    const bytes = await collect(writeArchive({ manifest: manifest(), bundles: bundles() }));
    await expect(
      readArchive(pieces(bytes), {
        limits: {
          maxInputBytes: 64 * 1024,
          maxEntryBytes: 8 * 1024,
          maxUncompressedBytes: 64 * 1024,
          maxEntries: 3,
          maxItems: 2,
          maxCompressionRatio: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'archive.compression_ratio' });
  });

  it('applies a read deadline while waiting for the next compressed chunk', async () => {
    async function* stalled(): AsyncGenerator<Uint8Array> {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield new Uint8Array();
    }
    await expect(readArchive(stalled(), { signal: AbortSignal.timeout(1) })).rejects.toMatchObject({
      code: 'archive.timed_out',
    });
  });

  it('refuses a descendant below depth 32', async () => {
    const items = Array.from({ length: 34 }, (_unused, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const parentId =
        index === 0 ? null : `00000000-0000-4000-8000-${String(index - 1).padStart(12, '0')}`;
      return { id, parentId, seq: String(index), title: `Level ${String(index)}`, type: 'note' };
    });
    const first = items[0];
    if (first === undefined) throw new Error('The depth fixture must contain a root.');
    const deepManifest: ArchiveManifest = { ...manifest(), root: first.id, items };
    // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer consumes an async source.
    async function* deepBundles(): AsyncGenerator<ItemBundle> {
      for (const item of items) {
        yield {
          ...bundle(ROOT),
          id: item.id,
          parentId: item.parentId,
          seq: item.seq,
          title: item.title,
          views: null,
        };
      }
    }
    const bytes = await collect(writeArchive({ manifest: deepManifest, bundles: deepBundles() }));
    await expect(readArchive(pieces(bytes))).rejects.toMatchObject({
      code: 'archive.tree_too_deep',
    });
  });
});
