import type { ItemBundle, SchemaSnapshot } from '@nix/export';
import type { Pool } from 'pg';

import {
  copyBodies,
  TemplateBodyError,
  validateArchiveBodies,
  writeArchiveBodies,
} from './bodies.ts';
import {
  CoreTemplateError,
  type ApplicationBegin,
  type CoreTemplateClient,
  type FinalizeTemplateResult,
  type ManagedFinalizeResult,
  type OperationKind,
  type TemplateDraft,
  type TemplateDraftItem,
  type TemplateImportAuthorization,
  type TemplateStageSweep,
} from './core.ts';
import { prepareTemplateArchive, type PreparedTemplateExport } from './export.ts';
import type {
  ApplicationRequest,
  CaptureRequest,
  DraftItemPatch,
  DraftMetadataPatch,
  ImportedTemplate,
  StagedImport,
} from './http-contracts.ts';

export type {
  ApplicationRequest,
  CaptureRequest,
  DraftItemPatch,
  DraftMetadataPatch,
  ImportedTemplate,
  StagedImport,
} from './http-contracts.ts';

export interface ImportValidationResult {
  readonly itemCount: number;
  readonly bodyCount: number;
}

export interface CaptureResult {
  readonly templateId: string;
  readonly operationId: string;
  readonly fileTransferJobId: string | null;
  readonly fileTransferPending: boolean;
  readonly writtenTargetItemIds: readonly string[];
}

export interface ApplicationResult extends ApplicationBegin {
  readonly operationId: string;
  readonly writtenTargetItemIds: readonly string[];
}

export interface TemplateService {
  validateImport(token: string, request: ImportedTemplate): Promise<ImportValidationResult>;
  capture(token: string, request: CaptureRequest): Promise<CaptureResult>;
  importTemplate(token: string, request: ImportedTemplate): Promise<StagedImport>;
  stageImport(token: string, request: ImportedTemplate): Promise<StagedImport>;
  finalizeManaged(
    token: string,
    workspaceId: string,
    imports: readonly StagedImport[],
    activeStableKeys: readonly string[],
  ): Promise<ManagedFinalizeResult>;
  abortImport(token: string, operationId: string): Promise<void>;
  sweepExpired(token: string, workspaceId: string): Promise<TemplateStageSweep>;
  authorizeImport(token: string, workspaceId: string): Promise<TemplateImportAuthorization>;
  beginDraft(token: string, templateId: string, idempotencyKey: string): Promise<TemplateDraft>;
  getDraft(token: string, templateId: string, operationId: string): Promise<TemplateDraft>;
  patchDraft(
    token: string,
    templateId: string,
    operationId: string,
    body: DraftMetadataPatch,
  ): Promise<TemplateDraft>;
  patchDraftItem(
    token: string,
    templateId: string,
    operationId: string,
    sourceId: string,
    body: DraftItemPatch,
  ): Promise<TemplateDraftItem>;
  saveDraft(
    token: string,
    templateId: string,
    operationId: string,
  ): Promise<FinalizeTemplateResult>;
  discardDraft(token: string, templateId: string, operationId: string): Promise<void>;
  apply(token: string, request: ApplicationRequest): Promise<ApplicationResult>;
  exportTemplate(
    token: string,
    templateId: string,
    exportedAt: Date,
    signal?: AbortSignal,
  ): Promise<PreparedTemplateExport>;
}

export function createTemplateService(options: {
  readonly pool: Pool;
  readonly core: CoreTemplateClient;
  readonly flushItems?: ((itemIds: readonly string[]) => Promise<void>) | undefined;
  readonly sealItems?: ((itemIds: readonly string[]) => Promise<void>) | undefined;
  readonly invalidateItems?: ((itemIds: readonly string[]) => Promise<void>) | undefined;
  readonly blockDraftAuthorization?: ((operationId: string) => void) | undefined;
  readonly completeDraftAuthorization?: ((operationId: string) => void) | undefined;
  readonly releaseDraftAuthorization?: ((operationId: string) => void) | undefined;
}): TemplateService {
  return {
    async validateImport(token, request) {
      const authorization = await options.core.authorizeImport(token, request.workspaceId);
      if (!authorization.canWrite) {
        throw new CoreTemplateError(
          403,
          'template.import_forbidden',
          'This workspace is read-only.',
        );
      }
      validateArchiveBodies(request.bundles);
      return {
        itemCount: request.bundles.length,
        bodyCount: request.bundles.filter((bundle) => bundle.body !== null).length,
      };
    },
    async capture(token, request) {
      const begun = await options.core.beginCapture(token, request);
      if (begun.fileTransferPending) {
        return {
          templateId: begun.templateId,
          operationId: begun.operationId,
          fileTransferJobId: begun.fileTransferJobId,
          fileTransferPending: true,
          writtenTargetItemIds: [],
        };
      }
      const externalReferenceTargets = new Set<string>();
      return await stage(
        token,
        'captures',
        begun.operationId,
        async () => {
          if (begun.bodyCopies.length === 0) return [];
          const first = begun.bodyCopies[0];
          if (first === undefined) return [];
          const authorization = await options.core.authorizeOperationItem(
            token,
            begun.operationId,
            first.targetItemId,
          );
          return await copyBodies(
            options.pool,
            authorization,
            begun.bodyCopies,
            mapping(begun.itemMappings),
            {
              stubUnknown: false,
              onReferenceInventory: ({ externalTargetIds }) => {
                for (const targetId of externalTargetIds) externalReferenceTargets.add(targetId);
                if (externalReferenceTargets.size > 2_000) {
                  throw new TemplateBodyError(
                    'template.reference_limit_exceeded',
                    'The captured template has too many external item references.',
                  );
                }
              },
            },
          );
        },
        {
          templateId: begun.templateId,
          fileTransferJobId: begun.fileTransferJobId,
          fileTransferPending: false,
        },
        () => [...externalReferenceTargets].sort(),
      );
    },

    async importTemplate(token, request) {
      validateArchiveBodies(request.bundles);
      const staged = await stageImportOperation(options.pool, options.core, token, request);
      if (staged.operationId === null) return staged;
      try {
        await options.core.finalize(
          token,
          'imports',
          staged.operationId,
          staged.writtenTargetItemIds,
        );
        return staged;
      } catch (error) {
        await options.core.abort(token, 'imports', staged.operationId).catch(() => undefined);
        throw error;
      }
    },

    stageImport: (token, request) => {
      validateArchiveBodies(request.bundles);
      return stageImportOperation(options.pool, options.core, token, request);
    },

    finalizeManaged: (token, workspaceId, imports, activeStableKeys) =>
      options.core.finalizeManaged(token, workspaceId, imports, activeStableKeys),

    abortImport: (token, operationId) => options.core.abort(token, 'imports', operationId),
    async sweepExpired(token, workspaceId) {
      const swept = await options.core.sweepExpired(token, workspaceId);
      await options.invalidateItems?.(swept.itemIds);
      return swept;
    },
    async authorizeImport(token, workspaceId) {
      const authorization = await options.core.authorizeImport(token, workspaceId);
      if (!authorization.canWrite) {
        throw new CoreTemplateError(
          403,
          'template.import_forbidden',
          'This workspace is read-only.',
        );
      }
      return authorization;
    },

    async beginDraft(token, templateId, idempotencyKey) {
      const begun = await options.core.beginDraft(token, templateId, idempotencyKey);
      if (begun.fileTransferPending) return begun;
      try {
        if (begun.bodyCopies.length > 0) {
          const first = begun.bodyCopies[0];
          if (first === undefined) throw new Error('The draft body plan is empty.');
          const authorization = await options.core.authorizeOperationItem(
            token,
            begun.operationId,
            first.targetItemId,
          );
          await copyBodies(
            options.pool,
            authorization,
            begun.bodyCopies,
            mapping(begun.itemMappings),
            { stubUnknown: false },
          );
        }
        return begun;
      } catch (error) {
        await options.core
          .discardDraft(token, templateId, begun.operationId)
          .catch(() => undefined);
        throw error;
      }
    },
    getDraft: (token, templateId, operationId) =>
      options.core.getDraft(token, templateId, operationId),
    patchDraft: (token, templateId, operationId, body) =>
      options.core.patchDraft(token, templateId, operationId, body),
    patchDraftItem: (token, templateId, operationId, sourceId, body) =>
      options.core.patchDraftItem(token, templateId, operationId, sourceId, body),
    async saveDraft(token, templateId, operationId) {
      const draft = await options.core.getDraft(token, templateId, operationId);
      if (draft.fileTransferPending) {
        throw new CoreTemplateError(
          409,
          'template.file_transfer_pending',
          'Template files are still being prepared. Resume the draft after the file transfer completes.',
        );
      }
      const itemIds = draft.itemMappings.map((item) => item.itemId);
      // Stop cached, new and in-flight authorization before body rooms begin sealing. The fence
      // remains fail-closed across an ambiguous Core response; only a proven refusal reopens it.
      options.blockDraftAuthorization?.(operationId);
      let saveStarted = false;
      try {
        if (options.sealItems !== undefined) {
          await options.sealItems(itemIds);
        } else {
          await options.flushItems?.(itemIds);
        }
        saveStarted = true;
        const saved = await options.core.saveDraft(token, templateId, operationId);
        options.completeDraftAuthorization?.(operationId);
        return saved;
      } catch (error) {
        if (!saveStarted || isSafeDraftSaveRefusal(error)) {
          options.releaseDraftAuthorization?.(operationId);
        }
        throw error;
      }
    },
    async discardDraft(token, templateId, operationId) {
      const draft = await options.core.getDraft(token, templateId, operationId);
      options.blockDraftAuthorization?.(operationId);
      await options.sealItems?.(draft.itemMappings.map((item) => item.itemId));
      await options.core.discardDraft(token, templateId, operationId);
      options.completeDraftAuthorization?.(operationId);
    },

    async apply(token, request) {
      const begun = await options.core.beginApplication(token, request);
      if (begun.fileTransferPending) {
        return {
          ...begun,
          operationId: begun.applicationId,
          writtenTargetItemIds: [],
        };
      }
      return await stage(
        token,
        'applications',
        begun.applicationId,
        async () => {
          if (begun.bodyCopies.length === 0) return [];
          const first = begun.bodyCopies[0];
          if (first === undefined) return [];
          const authorization = await options.core.authorizeOperationItem(
            token,
            begun.applicationId,
            first.targetItemId,
          );
          return await copyBodies(
            options.pool,
            authorization,
            begun.bodyCopies,
            mapping(begun.itemMappings),
            {
              stubUnknown: true,
              textBindings: begun.textBindings,
              referenceMappings: new Map(Object.entries(begun.referenceMappings)),
            },
          );
        },
        begun,
      );
    },

    exportTemplate: (token, templateId, exportedAt, signal) =>
      prepareTemplateArchive({
        core: options.core,
        pool: options.pool,
        token,
        templateId,
        exportedAt,
        ...(signal === undefined ? {} : { signal }),
      }),
  };

  async function stage<TResult extends object>(
    token: string,
    kind: OperationKind,
    operationId: string,
    write: () => Promise<readonly string[]>,
    result: TResult,
    externalReferenceTargets?: () => readonly string[],
  ): Promise<TResult & { operationId: string; writtenTargetItemIds: readonly string[] }> {
    try {
      const writtenTargetItemIds = await write();
      await options.core.finalize(
        token,
        kind,
        operationId,
        writtenTargetItemIds,
        externalReferenceTargets?.(),
      );
      return { ...result, operationId, writtenTargetItemIds };
    } catch (error) {
      await safeAbort(token, kind, operationId);
      throw error;
    }
  }

  async function safeAbort(token: string, kind: OperationKind, operationId: string): Promise<void> {
    await options.core.abort(token, kind, operationId).catch(() => undefined);
  }
}

function isSafeDraftSaveRefusal(error: unknown): boolean {
  return error instanceof CoreTemplateError && error.status >= 400 && error.status < 500;
}

async function stageImportOperation(
  pool: Pool,
  core: CoreTemplateClient,
  token: string,
  request: ImportedTemplate,
): Promise<StagedImport> {
  const begun = await core.beginImport(token, importPlan(request));
  if (begun.unchanged) {
    return {
      operationId: null,
      templateId: begun.templateId,
      stableKey: request.profile.key,
      digest: request.digest,
      unchanged: true,
      writtenTargetItemIds: [],
    };
  }
  if (begun.operationId === null) {
    throw new CoreTemplateError(
      502,
      'template.core_contract_invalid',
      'Core returned a changed import without an operation identifier.',
    );
  }
  try {
    let writtenTargetItemIds: readonly string[] = [];
    if (begun.bodyWrites.length > 0) {
      const first = begun.bodyWrites[0];
      if (first === undefined) throw new Error('The import body plan is empty.');
      const authorization = await core.authorizeOperationItem(
        token,
        begun.operationId,
        first.targetItemId,
      );
      const bundles = new Map(request.bundles.map((bundle) => [bundle.id, bundle]));
      const writes = begun.bodyWrites.map((write) => {
        const body = bundles.get(write.sourceId)?.body;
        if (body === null || body === undefined) {
          throw new TemplateBodyError(
            'template.import_body_missing',
            `The validated archive has no body for ${write.sourceId}.`,
          );
        }
        return { ...write, body };
      });
      writtenTargetItemIds = await writeArchiveBodies(
        pool,
        authorization,
        writes,
        mapping(begun.itemMappings),
      );
    }
    return {
      operationId: begun.operationId,
      templateId: begun.templateId,
      stableKey: request.profile.key,
      digest: request.digest,
      unchanged: false,
      writtenTargetItemIds,
    };
  } catch (error) {
    await core.abort(token, 'imports', begun.operationId).catch(() => undefined);
    throw error;
  }
}

function importPlan(request: ImportedTemplate): object {
  return {
    workspaceId: request.workspaceId,
    idempotencyKey: request.idempotencyKey,
    template: {
      stableKey: request.profile.key,
      title: request.profile.name,
      description: request.profile.description,
      origin: request.origin,
      ...(request.managedSource === undefined ? {} : { managedSource: request.managedSource }),
      digest: request.digest,
      includeBody: request.profile.includeBody,
      includeChildren: request.profile.includeChildren,
      initialization: request.profile.initialization ?? {
        version: 1,
        inputs: [],
        rules: [],
        references: [],
      },
    },
    items: request.bundles.map((bundle) => ({
      sourceId: bundle.id,
      ...(bundle.parentId === null ? {} : { parentSourceId: bundle.parentId }),
      itemType: bundle.type,
      title: bundle.title,
      seq: bundle.seq,
      properties: bundle.properties,
      schema: importSchema(request, bundle),
      views: bundle.views,
      recurrence: bundle.recurrence ?? null,
      hasBody: bundle.body !== null,
    })),
  };
}

function importSchema(
  request: ImportedTemplate,
  bundle: ItemBundle,
): { properties: SchemaSnapshot['properties']; inherit: boolean } | null {
  if (bundle.id === request.manifest.root) {
    const effective = request.manifest.rootEffectiveSchema ?? bundle.schema;
    return effective === null ? null : { properties: effective.properties, inherit: false };
  }
  return bundle.schema === null
    ? null
    : { properties: bundle.schema.declared, inherit: bundle.schema.inherit };
}

function mapping(
  items: readonly { sourceId: string; itemId: string }[],
): ReadonlyMap<string, string> {
  return new Map(items.map((item) => [item.sourceId, item.itemId]));
}
