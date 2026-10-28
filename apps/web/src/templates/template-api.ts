import {
  files as coreFiles,
  operations as coreOperations,
  templateImports as coreTemplateImports,
  templates as coreTemplates,
  structure as coreStructure,
  views as coreViews,
  type BeginTemplateImportInput,
  type NixClient,
  type TemplateDetail,
  type TemplateDraft,
  type TemplateImport,
  type TemplateImportPreview,
  type TemplateInitialization,
  type TemplateInitializationRule,
  type TemplateInput,
  type TemplateReferenceRule,
  type TemplateItem,
  type TemplatePreflight,
  type TemplateSummary,
} from '@nix/api-client';

import type { EffectiveSchema } from '../views/core/container-model';

export { templateImportPreviewSchema as TemplateImportPreviewSchema } from '@nix/api-client';
export type {
  TemplateDetail,
  TemplateImportPreview,
  TemplateInitialization,
  TemplateInitializationRule,
  TemplateInput,
  TemplateItem,
  TemplatePreflight,
  TemplateReferenceRule,
  TemplateSummary,
};

export type TemplateEditDraft = TemplateDraft;

export const templateImportById = coreTemplateImports.byId;

export async function beginAndPreviewTemplate(
  client: NixClient,
  input: BeginTemplateImportInput,
  source: Blob,
  signal?: AbortSignal,
  onStarted?: (importId: string) => void,
): Promise<TemplateImport> {
  if (source.size !== input.byteLength) {
    throw new RangeError('The template upload size does not match its declared byte length.');
  }

  const upload = await client.execute(coreTemplateImports.begin(input), { signal });
  onStarted?.(upload.id);
  let templateImport: TemplateImport | null = null;
  try {
    if (upload.uploadUrl !== null) {
      await coreFiles.putUploadCapability(upload.uploadUrl, source, signal);
      const queued = await client.execute(coreTemplateImports.preview(upload.id), { signal });
      await coreOperations.waitForOperation(
        client,
        queued.id,
        signal === undefined ? {} : { signal },
      );
    } else {
      templateImport = await client.query(coreTemplateImports.byId(upload.id), {
        signal,
        forceRefresh: true,
      });
      if (
        templateImport.status === 'preview_queued' &&
        templateImport.previewOperationId !== null
      ) {
        await coreOperations.waitForOperation(
          client,
          templateImport.previewOperationId,
          signal === undefined ? {} : { signal },
        );
        templateImport = null;
      }
    }

    templateImport ??= await client.query(coreTemplateImports.byId(upload.id), {
      signal,
      forceRefresh: true,
    });
    if (!hasTemplatePreview(templateImport)) {
      throw new Error(
        templateImport.failureCode ??
          (upload.uploadUrl === null
            ? 'The template upload capability is no longer available. Start a new import.'
            : 'The template preview did not become ready.'),
      );
    }
    return templateImport;
  } catch (error) {
    if (signal?.aborted === true) throw error;
    const recovered = await readTemplateImport(client, upload.id, signal);
    const resumed = await resumeTemplatePreview(client, recovered, signal).catch(
      (recoveryError: unknown) => {
        if (signal?.aborted === true) throw recoveryError;
        return null;
      },
    );
    if (resumed !== null && hasTemplatePreview(resumed)) return resumed;
    throw error;
  }
}

export async function commitAndWaitTemplate(
  client: NixClient,
  importId: string,
  expectedDigest: string,
  signal?: AbortSignal,
): Promise<TemplateImport> {
  let templateImport: TemplateImport | null = null;
  try {
    const queued = await client.execute(coreTemplateImports.commit(importId, expectedDigest), {
      signal,
    });
    await coreOperations.waitForOperation(
      client,
      queued.id,
      signal === undefined ? {} : { signal },
    );
  } catch (error) {
    if (signal?.aborted === true) throw error;
    templateImport = await readTemplateImport(client, importId, signal);
    templateImport = await resumeTemplateCommit(client, templateImport, signal).catch(
      (recoveryError: unknown) => {
        if (signal?.aborted === true) throw recoveryError;
        return templateImport;
      },
    );
    if (!isCompletedTemplateImport(templateImport)) throw error;
  }

  templateImport ??= await client.query(coreTemplateImports.byId(importId), {
    signal,
    forceRefresh: true,
  });
  if (!isCompletedTemplateImport(templateImport)) {
    throw new Error(templateImport.failureCode ?? 'The template import did not publish.');
  }
  client.invalidate(['workspaces', templateImport.workspaceId, 'templates']);
  return templateImport;
}

export async function cancelTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.execute(
    coreTemplateImports.cancel(importId),
    signal === undefined ? {} : { signal },
  );
}

async function readTemplateImport(
  client: NixClient,
  importId: string,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  try {
    return await client.query(coreTemplateImports.byId(importId), {
      signal,
      forceRefresh: true,
    });
  } catch (error) {
    if (signal?.aborted === true) throw error;
    return null;
  }
}

async function resumeTemplatePreview(
  client: NixClient,
  templateImport: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (templateImport !== null && hasTemplatePreview(templateImport)) return templateImport;
  if (templateImport?.status !== 'preview_queued' || templateImport.previewOperationId === null) {
    return templateImport;
  }
  await coreOperations.waitForOperation(
    client,
    templateImport.previewOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(coreTemplateImports.byId(templateImport.id), {
    signal,
    forceRefresh: true,
  });
}

async function resumeTemplateCommit(
  client: NixClient,
  templateImport: TemplateImport | null,
  signal?: AbortSignal,
): Promise<TemplateImport | null> {
  if (templateImport !== null && isCompletedTemplateImport(templateImport)) return templateImport;
  if (
    templateImport === null ||
    !['commit_queued', 'staging', 'staged'].includes(templateImport.status) ||
    templateImport.commitOperationId === null
  ) {
    return templateImport;
  }
  await coreOperations.waitForOperation(
    client,
    templateImport.commitOperationId,
    signal === undefined ? {} : { signal },
  );
  return await client.query(coreTemplateImports.byId(templateImport.id), {
    signal,
    forceRefresh: true,
  });
}

function hasTemplatePreview(templateImport: TemplateImport | null): boolean {
  return (
    templateImport !== null &&
    ['preview_ready', 'commit_queued', 'staging', 'staged', 'completed'].includes(
      templateImport.status,
    ) &&
    templateImport.preview !== null
  );
}

function isCompletedTemplateImport(templateImport: TemplateImport | null): boolean {
  return templateImport?.status === 'completed' && templateImport.result !== null;
}

export const templateById = coreTemplates.templateById;
export const templateCaptureSourceSchema = coreStructure.effectiveSchema;
export const templateCaptureSourceViews = coreViews.containerViews;
export const templateEditDraftById = coreTemplates.templateDraftById;
export const beginTemplateEditDraft = coreTemplates.beginTemplateDraft;
export const updateTemplateEditDraft = coreTemplates.updateTemplateDraft;
export const discardTemplateEditDraft = coreTemplates.discardTemplateDraft;

export function updateTemplateEditDraftItem(
  templateId: string,
  operationId: string,
  sourceId: string,
  input: {
    readonly title?: string | undefined;
    readonly properties?: Readonly<Record<string, unknown>> | null | undefined;
    readonly schema?: EffectiveSchema | null | undefined;
    readonly views?: TemplateItem['views'];
  },
): ReturnType<typeof coreTemplates.updateTemplateDraftItem> {
  const schema =
    input.schema === undefined || input.schema === null
      ? input.schema
      : { properties: input.schema.declared, inherit: input.schema.inherit };
  return coreTemplates.updateTemplateDraftItem(templateId, operationId, sourceId, {
    ...input,
    schema,
  });
}

export function saveTemplateEditDraft(
  template: TemplateSummary,
  operationId: string,
): ReturnType<typeof coreTemplates.saveTemplateDraft> {
  return coreTemplates.saveTemplateDraft(template.id, template.workspaceId, operationId);
}

export const deleteTemplate = coreTemplates.deleteTemplate;

export const exportTemplate = coreTemplates.exportTemplate;

export const preflightTemplate = coreTemplates.preflightTemplate;

export const captureTemplate = coreTemplates.captureTemplate;

export const applyStoredTemplate = coreTemplates.applyTemplate;
export const resumeTemplateFileTransfer = coreTemplates.resumeTemplateFileTransfer;
