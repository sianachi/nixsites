import { describe, expect, it } from 'vitest';

import {
  applyTemplate,
  beginTemplateDraft,
  captureTemplate,
  deleteTemplate,
  discardTemplateDraft,
  exportTemplate,
  listTemplates,
  preflightTemplate,
  previewTemplateCapture,
  saveTemplateDraft,
  templateById,
  templateItemById,
  templateDraftById,
  templateKey,
  templateLibraryKey,
  updateTemplateDraft,
  updateTemplateDraftItem,
  resumeTemplateFileTransfer,
} from './templates.js';
import type { NixClient } from '../client.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const TEMPLATE_ID = 'a1111111-1111-4111-8111-111111111111';
const SOURCE_ID = 'a2111111-1111-4111-8111-111111111111';
const OPERATION_ID = 'a3111111-1111-4111-8111-111111111111';

describe('the templates resource', () => {
  it('owns every Core template URL and stable cache identity', () => {
    expect(listTemplates(WORKSPACE_ID)).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE_ID}/templates`,
      cacheKey: templateLibraryKey(WORKSPACE_ID),
    });
    expect(templateById(TEMPLATE_ID)).toMatchObject({
      path: `/api/v1/templates/${TEMPLATE_ID}`,
      cacheKey: templateKey(TEMPLATE_ID),
    });
    expect(templateItemById(TEMPLATE_ID, SOURCE_ID)).toMatchObject({
      path: `/api/v1/templates/${TEMPLATE_ID}/items/${SOURCE_ID}`,
      cacheKey: [...templateKey(TEMPLATE_ID), 'items', SOURCE_ID],
    });
  });

  it('normalizes omitted preflight values to the nullable wire contract', () => {
    const endpoint = preflightTemplate(TEMPLATE_ID, { mode: 'create', title: 'Daily tracker' });

    expect(endpoint.body).toEqual({
      mode: 'create',
      targetItemId: null,
      parentItemId: null,
      title: 'Daily tracker',
    });
  });

  it('carries initialization values and expected revision through preflight and application', () => {
    const preflight = preflightTemplate(TEMPLATE_ID, {
      mode: 'create',
      title: 'Quarterly plan',
      inputs: { project_name: 'Quarterly plan' },
      expectedRevision: 7,
    });
    const application = applyTemplate({
      templateId: TEMPLATE_ID,
      mode: 'create',
      parentItemId: null,
      title: 'Quarterly plan',
      inputs: { project_name: 'Quarterly plan' },
      expectedRevision: 7,
      idempotencyKey: OPERATION_ID,
    });

    expect(preflight.body).toMatchObject({
      inputs: { project_name: 'Quarterly plan' },
      expectedRevision: 7,
    });
    expect(application).toMatchObject({
      path: '/collab/templates/applications',
      body: {
        inputs: { project_name: 'Quarterly plan' },
        expectedRevision: 7,
      },
    });
  });

  it('exposes capture, draft editing, save, discard and archive export descriptors', () => {
    const capture = captureTemplate({
      workspaceId: WORKSPACE_ID,
      sourceItemId: SOURCE_ID,
      title: 'Quarterly plan',
      description: null,
      includeBody: true,
      includeChildren: true,
      idempotencyKey: OPERATION_ID,
      expectedFingerprint: 'a'.repeat(64),
    });
    const beginDraft = beginTemplateDraft(TEMPLATE_ID, OPERATION_ID);
    const readDraft = templateDraftById(TEMPLATE_ID, OPERATION_ID);
    const updateDraft = updateTemplateDraft(TEMPLATE_ID, OPERATION_ID, {
      initialization: { version: 1, inputs: [], rules: [], references: [] },
    });
    const updateItem = updateTemplateDraftItem(TEMPLATE_ID, OPERATION_ID, SOURCE_ID, {
      title: 'Project root',
    });

    expect(capture.path).toBe('/collab/templates/captures');
    expect(capture.body).toMatchObject({ expectedFingerprint: 'a'.repeat(64) });
    expect(beginDraft.path).toBe(`/collab/templates/${TEMPLATE_ID}/drafts`);
    expect(readDraft.path).toBe(`/collab/templates/${TEMPLATE_ID}/drafts/${OPERATION_ID}`);
    expect(updateDraft.body).toEqual({
      initialization: { version: 1, inputs: [], rules: [], references: [] },
    });
    expect(updateItem.path).toBe(
      `/collab/templates/${TEMPLATE_ID}/drafts/${OPERATION_ID}/items/${SOURCE_ID}`,
    );
    expect(saveTemplateDraft(TEMPLATE_ID, WORKSPACE_ID, OPERATION_ID).path).toContain('/save');
    expect(discardTemplateDraft(TEMPLATE_ID, OPERATION_ID).method).toBe('DELETE');
    expect(exportTemplate(TEMPLATE_ID).path).toBe(`/collab/templates/${TEMPLATE_ID}/export`);
  });

  it('keeps projected sample exclusion in the capture preview cache identity', () => {
    const included = previewTemplateCapture(WORKSPACE_ID, SOURCE_ID);
    const excluded = previewTemplateCapture(WORKSPACE_ID, SOURCE_ID, true, true);
    expect(excluded.path).toContain('excludeSampleDescendants=true');
    expect(included.path).toContain('excludeSampleDescendants=false');
    expect(excluded.cacheKey).not.toEqual(included.cacheKey);
  });

  it('invalidates both detail and catalog after deletion', () => {
    const endpoint = deleteTemplate({ id: TEMPLATE_ID, workspaceId: WORKSPACE_ID });

    expect(endpoint.invalidates).toEqual([
      templateKey(TEMPLATE_ID),
      templateLibraryKey(WORKSPACE_ID),
    ]);
  });

  it('polls the Core file job and replays the same idempotent Collab command', async () => {
    const paths: string[] = [];
    let replayCount = 0;
    const client = {
      query: (endpoint: { readonly path: string }) => {
        paths.push(endpoint.path);
        return Promise.resolve({
          id: OPERATION_ID,
          kind: 'template.files.copy',
          status: 'completed',
          result: null,
          errorCode: null,
          errorDetail: null,
          attempts: 1,
          cancellationRequested: false,
          createdAt: '2026-09-20T00:00:00Z',
          completedAt: '2026-09-20T00:00:01Z',
        });
      },
    } as unknown as NixClient;

    const result = await resumeTemplateFileTransfer<{
      fileTransferJobId: string;
      fileTransferPending: boolean;
      operationId?: string;
    }>(client, { fileTransferJobId: OPERATION_ID, fileTransferPending: true }, () => {
      replayCount += 1;
      return Promise.resolve({
        fileTransferJobId: OPERATION_ID,
        fileTransferPending: false,
        operationId: TEMPLATE_ID,
      });
    });

    expect(paths).toEqual([`/api/v1/operations/${OPERATION_ID}`]);
    expect(replayCount).toBe(1);
    expect(result.fileTransferPending).toBe(false);
  });

  it('rejects a pending response without a file transfer job identity', async () => {
    await expect(
      resumeTemplateFileTransfer({} as NixClient, { fileTransferPending: true }, () =>
        Promise.resolve({}),
      ),
    ).rejects.toThrow(/without a job identity/);
  });
});
