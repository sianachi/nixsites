/** Workspace templates: Core-owned catalog, detail, validation and deletion endpoints. */

import {
  defineBinaryQuery,
  defineCommand,
  defineQuery,
  type BinaryQueryEndpoint,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { z } from 'zod';
import {
  noContentSchema,
  templateCatalogSchema,
  templateApplicationRequestSchema,
  templateApplicationResultSchema,
  templateCaptureRequestSchema,
  templateCapturePreviewSchema,
  templateCaptureResultSchema,
  templateDraftItemPatchSchema,
  templateDraftMetadataPatchSchema,
  templateDraftSchema,
  templateDetailSchema,
  templateItemSchema,
  templatePreflightRequestSchema,
  templatePreflightSchema,
  type TemplateCatalog,
  type TemplateApplicationRequest,
  type TemplateApplicationResult,
  type TemplateCaptureRequest,
  type TemplateCapturePreview,
  type TemplateCaptureResult,
  type TemplateDraft,
  type TemplateDetail,
  type TemplateItem,
  type TemplatePreflight,
  type TemplatePreflightInput,
  type TemplateSummary,
} from '../schemas/index.js';
import { waitForOperation } from './operations.js';
import type { NixClient } from '../client.js';

/** Cache identity shared by every read and mutation of one workspace's template catalog. */
export const templateLibraryKey = (workspaceId: string): readonly string[] => [
  'workspaces',
  workspaceId,
  'templates',
];

/** Cache identity shared by a template detail and mutations of that template. */
export const templateKey = (templateId: string): readonly string[] => ['templates', templateId];

export const listTemplates = (workspaceId: string): QueryEndpoint<TemplateCatalog> =>
  defineQuery({
    operation: 'templates.list',
    path: `/api/v1/workspaces/${workspaceId}/templates`,
    schema: templateCatalogSchema,
    cacheKey: templateLibraryKey(workspaceId),
  });

export const templateById = (templateId: string): QueryEndpoint<TemplateDetail> =>
  defineQuery({
    operation: 'templates.get',
    path: `/api/v1/templates/${templateId}`,
    schema: templateDetailSchema,
    cacheKey: templateKey(templateId),
  });

export const templateItemById = (
  templateId: string,
  sourceId: string,
): QueryEndpoint<TemplateItem> =>
  defineQuery({
    operation: 'templates.items.get',
    path: `/api/v1/templates/${templateId}/items/${sourceId}`,
    schema: templateItemSchema,
    cacheKey: [...templateKey(templateId), 'items', sourceId],
  });

export const deleteTemplate = (
  template: Pick<TemplateSummary, 'id' | 'workspaceId'>,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'templates.delete',
    method: 'DELETE',
    path: `/api/v1/templates/${template.id}`,
    schema: noContentSchema,
    invalidates: [templateKey(template.id), templateLibraryKey(template.workspaceId)],
  });

export const preflightTemplate = (
  templateId: string,
  input: TemplatePreflightInput,
): CommandEndpoint<TemplatePreflight> =>
  defineCommand({
    operation: 'templates.preflight',
    method: 'POST',
    path: `/api/v1/templates/${templateId}/preflight`,
    body: templatePreflightRequestSchema.parse(input),
    schema: templatePreflightSchema,
  });

export const captureTemplate = (
  input: TemplateCaptureRequest,
): CommandEndpoint<TemplateCaptureResult> =>
  defineCommand({
    operation: 'templates.capture',
    method: 'POST',
    path: '/collab/templates/captures',
    body: templateCaptureRequestSchema.parse(input),
    schema: templateCaptureResultSchema,
    invalidates: [templateLibraryKey(input.workspaceId)],
  });

export const previewTemplateCapture = (
  workspaceId: string,
  sourceItemId: string,
  includeChildren = true,
  excludeSampleDescendants = false,
): QueryEndpoint<TemplateCapturePreview> =>
  defineQuery({
    operation: 'templates.capture.preview',
    path: `/api/v1/workspaces/${workspaceId}/templates/capture-preview/${sourceItemId}?includeChildren=${String(includeChildren)}&excludeSampleDescendants=${String(excludeSampleDescendants)}`,
    schema: templateCapturePreviewSchema,
    cacheKey: [
      ...templateLibraryKey(workspaceId),
      'capture-preview',
      sourceItemId,
      String(includeChildren),
      String(excludeSampleDescendants),
    ],
    staleAfterMs: 0,
  });

export const applyTemplate = (
  input: TemplateApplicationRequest,
): CommandEndpoint<TemplateApplicationResult> =>
  defineCommand({
    operation: 'templates.apply',
    method: 'POST',
    path: '/collab/templates/applications',
    body: templateApplicationRequestSchema.parse(input),
    schema: templateApplicationResultSchema,
    invalidates: [['items'], templateKey(input.templateId)],
  });

export const templateDraftById = (
  templateId: string,
  operationId: string,
): QueryEndpoint<TemplateDraft> =>
  defineQuery({
    operation: 'templates.drafts.get',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    schema: templateDraftSchema,
    cacheKey: [...templateKey(templateId), 'drafts', operationId],
    staleAfterMs: 0,
  });

export const beginTemplateDraft = (
  templateId: string,
  idempotencyKey: string,
): CommandEndpoint<TemplateDraft> =>
  defineCommand({
    operation: 'templates.drafts.begin',
    method: 'POST',
    path: `/collab/templates/${templateId}/drafts`,
    body: { idempotencyKey },
    schema: templateDraftSchema,
    invalidates: [[...templateKey(templateId), 'drafts']],
  });

export const updateTemplateDraft = (
  templateId: string,
  operationId: string,
  input: {
    readonly title?: string | undefined;
    readonly description?: string | null | undefined;
    readonly initialization?: TemplateDraft['initialization'] | undefined;
  },
): CommandEndpoint<TemplateDraft> =>
  defineCommand({
    operation: 'templates.drafts.update',
    method: 'PATCH',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    body: templateDraftMetadataPatchSchema.parse(input),
    schema: templateDraftSchema,
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });

export const updateTemplateDraftItem = (
  templateId: string,
  operationId: string,
  sourceId: string,
  input: {
    readonly title?: string | undefined;
    readonly properties?: Readonly<Record<string, unknown>> | null | undefined;
    readonly schema?:
      { readonly properties: readonly unknown[]; readonly inherit: boolean } | null | undefined;
    readonly views?: unknown;
  },
): CommandEndpoint<TemplateItem> =>
  defineCommand({
    operation: 'templates.drafts.items.update',
    method: 'PATCH',
    path: `/collab/templates/${templateId}/drafts/${operationId}/items/${sourceId}`,
    body: templateDraftItemPatchSchema.parse(input),
    schema: templateItemSchema,
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });

export const saveTemplateDraft = (
  templateId: string,
  workspaceId: string,
  operationId: string,
): CommandEndpoint<{ templateId: string }> =>
  defineCommand({
    operation: 'templates.drafts.save',
    method: 'POST',
    path: `/collab/templates/${templateId}/drafts/${operationId}/save`,
    body: {},
    schema: z.object({ templateId: z.uuid() }),
    invalidates: [templateKey(templateId), templateLibraryKey(workspaceId)],
  });

export const discardTemplateDraft = (
  templateId: string,
  operationId: string,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'templates.drafts.discard',
    method: 'DELETE',
    path: `/collab/templates/${templateId}/drafts/${operationId}`,
    schema: noContentSchema,
    invalidates: [[...templateKey(templateId), 'drafts', operationId]],
  });

export const exportTemplate = (templateId: string): BinaryQueryEndpoint =>
  defineBinaryQuery({
    operation: 'templates.export',
    path: `/collab/templates/${templateId}/export`,
  });

/** Polls the Core-owned file-copy job, then replays the same idempotent Collab command. */
export async function resumeTemplateFileTransfer<
  TResult extends {
    readonly fileTransferJobId?: string | null | undefined;
    readonly fileTransferPending?: boolean | undefined;
  },
>(
  client: NixClient,
  initial: TResult,
  replay: () => Promise<TResult>,
  signal?: AbortSignal,
): Promise<TResult> {
  if (initial.fileTransferPending !== true) return initial;
  const jobId = initial.fileTransferJobId;
  if (jobId === undefined || jobId === null) {
    throw new Error('Core reported a pending template file transfer without a job identity.');
  }
  await waitForOperation(client, jobId, signal === undefined ? {} : { signal });
  const resumed = await replay();
  if (resumed.fileTransferPending === true) {
    throw new Error('The template file transfer is complete, but the stage still reports pending.');
  }
  return resumed;
}
