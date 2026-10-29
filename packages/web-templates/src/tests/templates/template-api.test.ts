import { createNixClient, templateDetailSchema, templates } from '@nix/api-client';
import { describe, expect, it } from 'vitest';

import {
  beginAndPreviewTemplate,
  cancelTemplateImport,
  templateImportById,
  TemplateImportPreviewSchema,
  updateTemplateEditDraftItem,
} from '../../templates/template-api';
import { STUB_TEMPLATES, stubCoreApi } from '@nix/web-foundation/testing/api-stub';

const TEMPLATE_WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';

function client() {
  return createNixClient({
    baseUrl: globalThis.location.origin,
    tokens: {
      getAccessToken: () => null,
      refreshAccessToken: () => Promise.resolve(null),
    },
  });
}

describe('the template API boundary', () => {
  it('parses the workspace template summaries returned by Core', async () => {
    stubCoreApi();

    const library = await client().query(templates.listTemplates(TEMPLATE_WORKSPACE_ID));

    expect(library.templates.map((template) => template.title)).toEqual(
      STUB_TEMPLATES.map((template) => template.title),
    );
    expect(library.capabilities.canManage).toBe(true);
  });

  it('exports the durable Core template import workflow through the web boundary', async () => {
    const importId = 'a9000000-0000-4000-8000-000000000001';
    const writes = stubCoreApi();

    expect(templateImportById(importId)).toMatchObject({
      path: `/api/v1/template-imports/${importId}`,
      cacheKey: ['template-imports', importId],
    });
    await cancelTemplateImport(client(), importId);
    expect(writes.templateImportCancellations).toEqual([importId]);
  });

  it('waits for an already queued preview when an idempotent begin has no upload capability', async () => {
    const writes = stubCoreApi({ templateImportReplayPreviewQueued: true });
    const archive = new Blob(['template archive'], { type: 'application/x-nix-template' });

    const result = await beginAndPreviewTemplate(
      client(),
      {
        workspaceId: TEMPLATE_WORKSPACE_ID,
        fileName: 'template.nix',
        mediaType: archive.type,
        byteLength: archive.size,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000031',
      },
      archive,
    );

    expect(result.status).toBe('preview_ready');
    expect(result.preview?.digest).toBe('a'.repeat(64));
    expect(writes.templateUploadBodies).toEqual([]);
    expect(writes.templateImportReads).toEqual([result.id, result.id]);
    expect(writes.templateImportCancellations).toEqual([]);
  });

  it('rejects a preview that does not carry a template profile', () => {
    const result = TemplateImportPreviewSchema.safeParse({
      digest: 'abc123',
      itemCount: 1,
      bodyCount: 0,
      viewCount: 0,
    });

    expect(result.success).toBe(false);
  });

  it('normalizes Core stored schemas and sparse stored views for template use', () => {
    const detail = templateDetailSchema.parse({
      ...STUB_TEMPLATES[0],
      root: {
        sourceId: 'a1111111-1111-4111-8111-111111111110',
        itemType: 'note',
        title: 'Delivery board',
        seq: '1000',
        properties: {},
        schema: {
          inherit: false,
          properties: [{ key: 'status', label: 'Status', type: 'select', required: false }],
        },
        views: {
          default: 'board',
          views: [{ id: 'board', name: 'Board', kind: 'board', groupBy: 'status' }],
        },
        children: [],
        hasBody: false,
      },
    });

    expect(detail.root.schema).toEqual({
      inherit: false,
      properties: [
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
          choiceSource: null,
        },
      ],
      declared: [
        {
          key: 'status',
          label: 'Status',
          type: 'select',
          options: [],
          required: false,
          expression: null,
          aggregate: null,
          source: null,
          choiceSource: null,
        },
      ],
    });
    expect(detail.root.views?.views[0]).toMatchObject({
      id: 'board',
      columns: [],
      groupOrder: [],
      dateProperty: null,
      sortDescending: false,
      companionViewId: null,
    });
  });

  it('writes only a draft item schema declaration back to Core', () => {
    const endpoint = updateTemplateEditDraftItem(
      'a1111111-1111-4111-8111-111111111111',
      'a2222222-2222-4222-8222-222222222222',
      'a3333333-3333-4333-8333-333333333333',
      {
        schema: {
          properties: [
            { key: 'owner', label: 'Owner', type: 'text', options: [], required: false },
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          declared: [
            { key: 'status', label: 'Status', type: 'text', options: [], required: false },
          ],
          inherit: true,
        },
      },
    );

    expect(endpoint.body).toEqual({
      schema: {
        properties: [
          { key: 'status', label: 'Status', type: 'text', options: [], required: false },
        ],
        inherit: true,
      },
    });
  });
});
