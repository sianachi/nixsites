import { SCHEMA_VERSION } from '@nix/editor-schema';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  TEMPLATE_PROFILE_VERSION,
  readArchive,
  validateTemplateArchive,
  writeArchive,
  type ArchiveManifest,
  type ItemBody,
  type ItemBundle,
  type ReadArchiveResult,
  type ViewSnapshot,
  type ViewsSnapshot,
} from '@nix/export';
import { SHEET_SCHEMA_VERSION } from '@nix/sheet';
import { describe, expect, it } from 'vitest';

import { strategyFor } from '../documents/body-kinds.ts';
import { documentFromArchiveBody, remapItemReferences } from './bodies.ts';

const SOURCE = {
  root: '10000000-0000-4000-8000-000000000001',
  note: '10000000-0000-4000-8000-000000000002',
  canvas: '10000000-0000-4000-8000-000000000003',
  sheet: '10000000-0000-4000-8000-000000000004',
} as const;
const IMPORTED = {
  root: '20000000-0000-4000-8000-000000000001',
  note: '20000000-0000-4000-8000-000000000002',
  canvas: '20000000-0000-4000-8000-000000000003',
  sheet: '20000000-0000-4000-8000-000000000004',
} as const;
const REEXPORTED = {
  root: '30000000-0000-4000-8000-000000000001',
  note: '30000000-0000-4000-8000-000000000002',
  canvas: '30000000-0000-4000-8000-000000000003',
  sheet: '30000000-0000-4000-8000-000000000004',
} as const;
const OUTSIDE = '90000000-0000-4000-8000-000000000001';
const SOURCE_WORKSPACE = '40000000-0000-4000-8000-000000000001';
const IMPORT_WORKSPACE = '50000000-0000-4000-8000-000000000001';

const inheritedProperty = {
  key: 'owner',
  label: 'Owner',
  type: 'text',
  options: [],
  required: false,
} as const;
const declaredProperties = [
  { key: 'status', label: 'Status', type: 'select', options: ['Open', 'Done'], required: true },
  { key: 'due', label: 'Due', type: 'date', options: [], required: false },
  { key: 'start', label: 'Start', type: 'date', options: [], required: false },
  { key: 'end', label: 'End', type: 'date', options: [], required: false },
  { key: 'cover', label: 'Cover', type: 'image', options: [], required: false },
  { key: 'name', label: 'Name', type: 'text', options: [], required: true },
  { key: 'email', label: 'Email', type: 'text', options: [], required: false },
] as const;

describe('portable template archives', () => {
  it('preserves every body kind, stored view field and descendant body through export/import/export', async () => {
    const first = await archiveRoundTrip(sourceManifest(), sourceBundles());
    validateTemplateArchive(first);

    const sourceToImported = idMap(SOURCE, IMPORTED);
    const importedToPortable = idMap(IMPORTED, REEXPORTED);
    const secondManifest = remapManifest(first.manifest, idMap(SOURCE, REEXPORTED), {
      exportedAt: '2026-08-16T13:00:00.000Z',
    });
    const secondBundles = first.bundles.map((bundle) => {
      const importedBody = importAndMaterialize(bundle.type, bundle.body, sourceToImported);
      return {
        ...remapBundleEnvelope(bundle, idMap(SOURCE, REEXPORTED)),
        workspaceId: IMPORT_WORKSPACE,
        createdAt: '2026-08-16T13:00:00.000Z',
        updatedAt: '2026-08-16T13:00:00.000Z',
        body: exportMaterializedBody(bundle.type, bundle.body, importedBody, importedToPortable),
      };
    });

    const second = await archiveRoundTrip(secondManifest, secondBundles);
    validateTemplateArchive(second);

    const normalizedFirst = normalizeArchive(first, idMap(SOURCE, SOURCE), true);
    const normalizedSecond = normalizeArchive(second, idMap(REEXPORTED, SOURCE), false);
    expect(normalizedSecond).toEqual(normalizedFirst);
  });
});

function sourceManifest(): ArchiveManifest {
  return {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    profile: {
      kind: 'template',
      version: TEMPLATE_PROFILE_VERSION,
      key: 'project.complete',
      name: 'Complete project',
      description: 'Exercises every portable template field.',
      includeBody: false,
      includeChildren: true,
      initialization: {
        version: 1,
        inputs: [{ key: 'project_name', label: 'Project name', type: 'text', required: true }],
        rules: [],
        references: [],
      },
    },
    exportedAt: '2026-08-16T12:00:00.000Z',
    root: SOURCE.root,
    rootEffectiveSchema: {
      properties: [inheritedProperty, ...declaredProperties],
      declared: declaredProperties,
      inherit: true,
    },
    includesDeleted: false,
    items: [
      { id: SOURCE.root, parentId: null, seq: '1000', title: 'Project', type: 'note' },
      { id: SOURCE.note, parentId: SOURCE.root, seq: '1000', title: 'Brief', type: 'note' },
      { id: SOURCE.canvas, parentId: SOURCE.root, seq: '2000', title: 'Sketch', type: 'canvas' },
      {
        id: SOURCE.sheet,
        parentId: SOURCE.root,
        seq: '3000',
        title: 'Budget',
        type: 'spreadsheet',
      },
    ],
    omitted: [],
    loss: [],
  };
}

function sourceBundles(): readonly ItemBundle[] {
  const shared = {
    workspaceId: SOURCE_WORKSPACE,
    lifecycleState: 'active',
    createdAt: '2026-08-16T12:00:00.000Z',
    updatedAt: '2026-08-16T12:00:00.000Z',
    viewRows: [],
    viewRowsTruncated: false,
  } as const;
  return [
    {
      ...shared,
      id: SOURCE.root,
      parentId: null,
      type: 'note',
      title: 'Project',
      seq: '1000',
      properties: { owner: 'Ada', arbitraryId: OUTSIDE },
      schema: { properties: declaredProperties, declared: declaredProperties, inherit: true },
      views: allViews(),
      body: null,
    },
    {
      ...shared,
      id: SOURCE.note,
      parentId: SOURCE.root,
      type: 'note',
      title: 'Brief',
      seq: '1000',
      properties: { status: 'Open', due: '2026-08-20' },
      schema: null,
      views: null,
      body: {
        schemaVersion: SCHEMA_VERSION,
        prosemirror: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { textAlign: 'center', suggestion: null },
              content: [
                { type: 'text', text: 'See {{project_name}} ' },
                {
                  type: 'reference',
                  attrs: { kind: 'item', targetId: SOURCE.canvas, label: 'Sketch' },
                },
                { type: 'text', text: ' and ' },
                {
                  type: 'reference',
                  attrs: { kind: 'item', targetId: OUTSIDE, label: 'Outside note' },
                },
              ],
            },
          ],
        },
      },
    },
    {
      ...shared,
      id: SOURCE.canvas,
      parentId: SOURCE.root,
      type: 'canvas',
      title: 'Sketch',
      seq: '2000',
      properties: { status: 'Open' },
      schema: null,
      views: null,
      body: {
        schemaVersion: SCHEMA_VERSION,
        canvas: {
          elements: {
            shape: {
              id: 'shape',
              type: 'rectangle',
              version: 2,
              versionNonce: 91,
              text: 'Plan',
              linkedItem: {
                type: 'reference',
                attrs: { kind: 'item', targetId: SOURCE.note, label: 'Brief' },
              },
            },
          },
        },
      },
    },
    {
      ...shared,
      id: SOURCE.sheet,
      parentId: SOURCE.root,
      type: 'spreadsheet',
      title: 'Budget',
      seq: '3000',
      properties: { status: 'Done' },
      schema: null,
      views: null,
      body: {
        schemaVersion: SHEET_SCHEMA_VERSION,
        sheet: {
          body: 'sheet',
          cells: { A1: '2', B1: '=A1*3', C1: OUTSIDE },
          meta: { rows: 120, cols: 28, colWidths: { A: 240, B: 320 } },
        },
      },
    },
  ];
}

function allViews(): ViewsSnapshot {
  const view = (id: string, kind: string, fields: Partial<ViewSnapshot> = {}): ViewSnapshot => ({
    id,
    name: id,
    kind,
    columns: ['status', 'due'],
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
    interactiveForm: null,
    ...fields,
  });
  return {
    default: 'list',
    views: [
      view('list', 'list', {
        sortBy: 'due',
        sortDescending: true,
        filters: [{ property: 'status', operator: 'not-equals', value: 'Done' }],
        companionViewId: 'sheet',
        companionPlacement: 'beside',
      }),
      view('board', 'board', { groupBy: 'status', groupOrder: ['Open', 'Done'] }),
      view('calendar', 'calendar', { dateProperty: 'due', mode: 'month' }),
      view('gallery', 'gallery', { coverProperty: 'cover', cardSize: 'large' }),
      view('timeline', 'timeline', { dateProperty: 'start', endDateProperty: 'end', mode: 'week' }),
      view('sheet', 'sheet'),
      view('form', 'form'),
      view('query', 'query', {
        filters: [{ property: 'due', operator: 'on-or-after', value: '2026-08-16' }],
      }),
      view('interactive', 'interactive_form', {
        interactiveForm: {
          pages: [
            {
              id: 'identity',
              title: 'About you',
              description: 'Tell us who is responding.',
              visibleWhen: [],
              blocks: [
                {
                  id: 'heading',
                  kind: 'heading',
                  propertyKey: null,
                  text: 'Identity',
                  help: null,
                  required: false,
                  identityRole: null,
                  visibleWhen: [],
                },
                {
                  id: 'name',
                  kind: 'field',
                  propertyKey: 'name',
                  text: 'Name',
                  help: 'Your full name.',
                  required: true,
                  identityRole: 'name',
                  visibleWhen: [],
                },
                {
                  id: 'email',
                  kind: 'field',
                  propertyKey: 'email',
                  text: 'Email',
                  help: null,
                  required: false,
                  identityRole: 'email',
                  visibleWhen: [{ fieldBlockId: 'name', operator: 'contains', value: ' ' }],
                },
                {
                  id: 'help',
                  kind: 'paragraph',
                  propertyKey: null,
                  text: 'We only use this for the response.',
                  help: null,
                  required: false,
                  identityRole: null,
                  visibleWhen: [{ fieldBlockId: 'email', operator: 'not_equals', value: null }],
                },
              ],
            },
            {
              id: 'details',
              title: 'Details',
              description: null,
              visibleWhen: [{ fieldBlockId: 'name', operator: 'not_equals', value: '' }],
              blocks: [
                {
                  id: 'status',
                  kind: 'field',
                  propertyKey: 'status',
                  text: 'Status',
                  help: null,
                  required: true,
                  identityRole: null,
                  visibleWhen: [{ fieldBlockId: 'email', operator: 'contains', value: '@' }],
                },
              ],
            },
          ],
          titleMode: 'field',
          titleFieldBlockId: 'name',
          confirmationTitle: 'Saved',
          confirmationMessage: 'Your response is ready.',
        },
      }),
    ],
  };
}

async function archiveRoundTrip(
  manifest: ArchiveManifest,
  bundles: readonly ItemBundle[],
): Promise<ReadArchiveResult> {
  // eslint-disable-next-line @typescript-eslint/require-await -- the archive writer deliberately accepts a streaming source.
  async function* source(): AsyncGenerator<ItemBundle> {
    yield* bundles;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of writeArchive({ manifest, bundles: source() })) chunks.push(chunk);
  // eslint-disable-next-line @typescript-eslint/require-await -- chunking exercises the reader's asynchronous upload contract.
  async function* upload(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.byteLength; offset += 19) {
        yield chunk.subarray(offset, offset + 19);
      }
    }
  }
  return await readArchive(upload());
}

function importAndMaterialize(
  itemType: string,
  body: ItemBody | null,
  sourceToImported: ReadonlyMap<string, string>,
): unknown {
  if (body === null) return null;
  const remapped = mapBody(body, sourceToImported);
  return strategyFor(itemType).materialize(documentFromArchiveBody(itemType, remapped)).json;
}

function exportMaterializedBody(
  itemType: string,
  original: ItemBody | null,
  materialized: unknown,
  importedToPortable: ReadonlyMap<string, string>,
): ItemBody | null {
  if (original === null) return null;
  const portable = remapItemReferences(materialized, importedToPortable, true);
  if (itemType === 'canvas') return { schemaVersion: original.schemaVersion, canvas: portable };
  if (itemType === 'spreadsheet') return { schemaVersion: original.schemaVersion, sheet: portable };
  return { schemaVersion: original.schemaVersion, prosemirror: portable };
}

function mapBody(body: ItemBody, ids: ReadonlyMap<string, string>): ItemBody {
  if ('prosemirror' in body)
    return { ...body, prosemirror: remapItemReferences(body.prosemirror, ids, true) };
  if ('canvas' in body) return { ...body, canvas: remapItemReferences(body.canvas, ids, true) };
  return { ...body, sheet: remapItemReferences(body.sheet, ids, true) };
}

function remapManifest(
  manifest: ArchiveManifest,
  ids: ReadonlyMap<string, string>,
  changes: { readonly exportedAt: string },
): ArchiveManifest {
  return {
    ...manifest,
    ...changes,
    root: requiredId(ids, manifest.root),
    items: manifest.items.map((item) => ({
      ...item,
      id: requiredId(ids, item.id),
      parentId: item.parentId === null ? null : requiredId(ids, item.parentId),
    })),
  };
}

function remapBundleEnvelope(bundle: ItemBundle, ids: ReadonlyMap<string, string>): ItemBundle {
  return {
    ...bundle,
    id: requiredId(ids, bundle.id),
    parentId: bundle.parentId === null ? null : requiredId(ids, bundle.parentId),
  };
}

function normalizeArchive(
  archive: { readonly manifest: ArchiveManifest; readonly bundles: readonly ItemBundle[] },
  ids: ReadonlyMap<string, string>,
  stubExternal: boolean,
): unknown {
  return {
    manifest: remapManifest(archive.manifest, ids, { exportedAt: '<normalized>' }),
    bundles: archive.bundles.map((bundle) => {
      const normalized = remapBundleEnvelope(bundle, ids);
      return {
        ...normalized,
        workspaceId: '<normalized>',
        createdAt: '<normalized>',
        updatedAt: '<normalized>',
        body: normalized.body === null ? null : normalizeBody(normalized.body, ids, stubExternal),
      };
    }),
  };
}

function normalizeBody(
  body: ItemBody,
  ids: ReadonlyMap<string, string>,
  stubExternal: boolean,
): ItemBody {
  if ('prosemirror' in body)
    return { ...body, prosemirror: remapItemReferences(body.prosemirror, ids, stubExternal) };
  if ('canvas' in body)
    return { ...body, canvas: remapItemReferences(body.canvas, ids, stubExternal) };
  return { ...body, sheet: remapItemReferences(body.sheet, ids, stubExternal) };
}

function idMap(
  from: Record<string, string>,
  to: Record<string, string>,
): ReadonlyMap<string, string> {
  return new Map(Object.keys(from).map((key) => [from[key] ?? '', to[key] ?? '']));
}

function requiredId(ids: ReadonlyMap<string, string>, id: string): string {
  const mapped = ids.get(id);
  if (mapped === undefined) throw new Error(`The round-trip fixture has no mapping for ${id}.`);
  return mapped;
}
