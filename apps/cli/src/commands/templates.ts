/** Scriptable template catalog, authoring, and application workflows. */

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  createNixClient,
  operations,
  templateImports,
  templates as templateResources,
  templateDraftItemPatchSchema,
  templateDraftMetadataPatchSchema,
  templateApplicationRequestSchema,
  templateCaptureRequestSchema,
  templateInitializationSchema,
  type BinaryQueryEndpoint,
  type CallOptions,
  type CommandEndpoint,
  type NixClient,
  type PagedQueryEndpoint,
  type QueryEndpoint,
  type TemplateApplicationRequest,
  type TemplateCaptureRequest,
  type TemplateCaptureResult,
  type TemplateDraft,
  type TemplateInitialization,
} from '@nix/api-client';
import type { Session } from '../session.ts';
import { printResult, type OutputOptions } from '../output.ts';
import { resolveSession, type SessionDeps } from './shared.ts';

export type TemplateApplyOptions = Omit<
  TemplateApplicationRequest,
  'idempotencyKey' | 'expectedRevision'
> & {
  readonly expectedRevision?: number | undefined;
  readonly idempotencyKey?: string | undefined;
};

const MAX_TEMPLATE_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TEMPLATE_ARCHIVE_MEDIA_TYPE = 'application/vnd.nix.archive';

async function readBoundedArchive(path: string): Promise<Uint8Array> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 0 || size > MAX_TEMPLATE_ARCHIVE_BYTES) {
      throw new RangeError('Template archives must be between 1 byte and 64 MiB.');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_TEMPLATE_ARCHIVE_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_TEMPLATE_ARCHIVE_BYTES + 1 - total));
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > MAX_TEMPLATE_ARCHIVE_BYTES) {
        throw new RangeError('Template archives must be between 1 byte and 64 MiB.');
      }
    }
    if (total === 0) throw new RangeError('Template archives must be between 1 byte and 64 MiB.');
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}

export type TemplatePreflightOptions = Omit<TemplateApplicationRequest, 'idempotencyKey'>;

/** Uploads a portable template archive through Core's durable preview boundary. */
export async function executeTemplateArchivePreview(
  session: Session,
  workspaceId: string,
  archivePath: string,
  idempotencyKey = `nixctl-template-import:${randomUUID()}`,
): Promise<unknown> {
  const bytes = await readBoundedArchive(archivePath);
  const fileName = basename(archivePath);
  const operation = await templateImports.beginAndPreviewTemplate(
    session.client,
    {
      workspaceId,
      fileName,
      mediaType: TEMPLATE_ARCHIVE_MEDIA_TYPE,
      byteLength: bytes.byteLength,
      idempotencyKey,
    },
    new Blob([new Uint8Array(bytes)], { type: TEMPLATE_ARCHIVE_MEDIA_TYPE }),
  );
  return { preview: operation, resume: { id: operation.id, idempotencyKey } };
}

/** Publishes an already-previewed archive only when the caller confirms its exact digest. */
export async function executeTemplateArchiveCommit(
  session: Session,
  importId: string,
  digest: string,
): Promise<unknown> {
  return templateImports.commitAndWaitTemplate(session.client, importId, digest);
}

export async function executeTemplateImportGet(
  session: Session,
  importId: string,
): Promise<unknown> {
  return session.client.query(templateImports.byId(importId), { forceRefresh: true });
}

/** Cancels an authorized template archive import and its pending worker execution. */
export async function executeTemplateImportCancel(
  session: Session,
  importId: string,
): Promise<{ readonly canceled: true; readonly importId: string }> {
  await templateImports.cancelTemplateImport(session.client, importId);
  return { canceled: true, importId };
}

/** Downloads a portable archive from Collab and atomically writes it to the requested path. */
export async function executeTemplateArchiveExport(
  session: Session,
  templateId: string,
  outputPath: string,
): Promise<unknown> {
  const result = await collabClientFor(session).download(
    templateResources.exportTemplate(templateId),
    { maxResponseBytes: MAX_TEMPLATE_ARCHIVE_BYTES },
  );
  if (result.blob.size > MAX_TEMPLATE_ARCHIVE_BYTES) {
    throw new RangeError('The template archive exceeds the 256 MiB download limit.');
  }
  const temporaryPath = `${outputPath}.nixctl-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, new Uint8Array(await result.blob.arrayBuffer()), { flag: 'wx' });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    templateId,
    path: outputPath,
    byteLength: result.blob.size,
    mediaType: result.headers['content-type'] ?? 'application/zip',
  };
}

/** Opens the authenticated Collab origin while reusing the Core-minted short-lived token. */
export function collabClientFor(session: Session): NixClient {
  const transport = createNixClient({
    baseUrl: session.endpoints.collabUrl,
    tokens: session.tokens,
  });
  const directRoute = <T extends { readonly path: string }>(endpoint: T): T => ({
    ...endpoint,
    path: endpoint.path.replace(/^\/collab(?=\/)/, ''),
  });
  const client: NixClient = {
    cache: transport.cache,
    query: <T>(endpoint: QueryEndpoint<T>, options?: CallOptions) =>
      transport.query(directRoute(endpoint), options),
    queryResult: <T>(endpoint: QueryEndpoint<T>, options?: CallOptions) =>
      transport.queryResult(directRoute(endpoint), options),
    execute: <T>(endpoint: CommandEndpoint<T>, options?: CallOptions) =>
      transport.execute(directRoute(endpoint), options),
    stream: (request) =>
      transport.stream({ ...request, path: request.path.replace(/^\/collab(?=\/)/, '') }),
    download: (endpoint: BinaryQueryEndpoint, options?: CallOptions) =>
      transport.download(directRoute(endpoint), options),
    async *paginate<T>(endpoint: PagedQueryEndpoint<T>, options?: CallOptions) {
      yield* transport.paginate(directRoute(endpoint), options);
    },
    invalidate: (prefix) => {
      transport.invalidate(prefix);
    },
  };
  return client;
}

export async function executeTemplateCapture(
  session: Session,
  input: TemplateCaptureRequest,
  waitForFiles = true,
): Promise<TemplateCaptureResult> {
  const collab = collabClientFor(session);
  const endpoint = templateResources.captureTemplate(input);
  const result = await collab.execute(endpoint);
  if (!waitForFiles && result.fileTransferPending === true) return result;
  return templateResources.resumeTemplateFileTransfer(session.client, result, () =>
    collab.execute(endpoint),
  );
}

/** Begins an editable draft and resumes only after Core's file-copy operation is complete. */
export async function executeTemplateDraftBegin(
  session: Session,
  templateId: string,
  idempotencyKey: string,
  waitForFiles = true,
): Promise<TemplateDraft> {
  const collab = collabClientFor(session);
  const endpoint = templateResources.beginTemplateDraft(templateId, idempotencyKey);
  const first = await collab.execute(endpoint);
  if (!waitForFiles && first.fileTransferPending === true) return first;
  return templateResources.resumeTemplateFileTransfer(session.client, first, () =>
    collab.execute(endpoint),
  );
}

export async function executeTemplateDraftGet(
  session: Session,
  templateId: string,
  operationId: string,
): Promise<unknown> {
  return collabClientFor(session).query(
    templateResources.templateDraftById(templateId, operationId),
  );
}

export async function executeTemplateDraftUpdate(
  session: Session,
  templateId: string,
  operationId: string,
  input: Parameters<typeof templateResources.updateTemplateDraft>[2],
): Promise<unknown> {
  return collabClientFor(session).execute(
    templateResources.updateTemplateDraft(templateId, operationId, input),
  );
}

export async function executeTemplateDraftItemUpdate(
  session: Session,
  templateId: string,
  operationId: string,
  sourceId: string,
  input: Parameters<typeof templateResources.updateTemplateDraftItem>[3],
): Promise<unknown> {
  return collabClientFor(session).execute(
    templateResources.updateTemplateDraftItem(templateId, operationId, sourceId, input),
  );
}

export async function executeTemplateDraftSave(
  session: Session,
  templateId: string,
  operationId: string,
): Promise<unknown> {
  const template = await session.client.query(templateResources.templateById(templateId));
  return collabClientFor(session).execute(
    templateResources.saveTemplateDraft(templateId, template.workspaceId, operationId),
  );
}

export async function executeTemplateDraftDiscard(
  session: Session,
  templateId: string,
  operationId: string,
): Promise<unknown> {
  return collabClientFor(session).execute(
    templateResources.discardTemplateDraft(templateId, operationId),
  );
}

export async function executeTemplateOperationResume(
  session: Session,
  receipt: {
    readonly kind: 'capture' | 'apply' | 'draft';
    readonly jobId: string;
    readonly request: unknown;
  },
): Promise<unknown> {
  await operations.waitForOperation(session.client, receipt.jobId);
  const collab = collabClientFor(session);
  if (receipt.kind === 'capture') {
    const request = templateCaptureRequestSchema.parse(receipt.request);
    const endpoint = templateResources.captureTemplate(request);
    const result = await collab.execute(endpoint);
    if (result.fileTransferPending)
      throw new Error(
        'The file-copy operation completed, but capture still reports pending files.',
      );
    return result;
  }
  if (receipt.kind === 'apply') {
    const request = templateApplicationRequestSchema.parse(receipt.request);
    const endpoint = templateResources.applyTemplate(request);
    const result = await collab.execute(endpoint);
    if (result.fileTransferPending)
      throw new Error(
        'The file-copy operation completed, but application still reports pending files.',
      );
    return result;
  }
  const request = receipt.request as {
    templateId?: unknown;
    idempotencyKey?: unknown;
    workspaceId?: unknown;
    metadataPatch?: unknown;
  };
  if (typeof request.templateId !== 'string' || typeof request.idempotencyKey !== 'string') {
    throw new TypeError(
      'A draft resume receipt needs the original template ID and idempotency key.',
    );
  }
  const endpoint = templateResources.beginTemplateDraft(request.templateId, request.idempotencyKey);
  const draft = await collab.execute(endpoint);
  if (draft.fileTransferPending) {
    throw new Error(
      'The file-copy operation completed, but the draft still reports pending files.',
    );
  }
  if (request.metadataPatch === undefined) return draft;
  if (typeof request.workspaceId !== 'string') {
    throw new TypeError('A draft edit receipt needs the original workspace ID.');
  }
  const metadataPatch = templateDraftMetadataPatchSchema.parse(request.metadataPatch);
  await collab.execute(
    templateResources.updateTemplateDraft(request.templateId, draft.operationId, metadataPatch),
  );
  return collab.execute(
    templateResources.saveTemplateDraft(request.templateId, request.workspaceId, draft.operationId),
  );
}

export async function beginTemplateDraft(
  profileName: string | undefined,
  templateId: string,
  options: { readonly idempotencyKey?: string | undefined; readonly noWait?: boolean | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
  makeId: () => string = randomUUID,
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const idempotencyKey =
    options.idempotencyKey ?? `nixctl-template-draft:${templateId}:${makeId()}`;
  const draft = await executeTemplateDraftBegin(
    session,
    templateId,
    idempotencyKey,
    options.noWait !== true,
  );
  printResult(
    {
      draft,
      resume: draft.fileTransferPending
        ? {
            kind: 'draft',
            jobId: draft.fileTransferJobId,
            operationId: draft.operationId,
            idempotencyKey,
            request: { templateId, idempotencyKey },
          }
        : { idempotencyKey },
    },
    output,
  );
}

export async function getTemplateDraft(
  profileName: string | undefined,
  templateId: string,
  operationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  printResult(
    await executeTemplateDraftGet(await resolveSession(profileName, deps), templateId, operationId),
    output,
  );
}

export async function updateTemplateDraftFromFile(
  profileName: string | undefined,
  templateId: string,
  operationId: string,
  patchPath: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const patch = templateDraftMetadataPatchSchema.parse(
    JSON.parse(await readFile(patchPath, 'utf8')),
  );
  printResult(await executeTemplateDraftUpdate(session, templateId, operationId, patch), output);
}

export async function updateTemplateDraftItemFromFile(
  profileName: string | undefined,
  templateId: string,
  operationId: string,
  sourceId: string,
  patchPath: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const patch = templateDraftItemPatchSchema.parse(JSON.parse(await readFile(patchPath, 'utf8')));
  printResult(
    await executeTemplateDraftItemUpdate(session, templateId, operationId, sourceId, patch),
    output,
  );
}

export async function saveTemplateDraft(
  profileName: string | undefined,
  templateId: string,
  operationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  printResult(
    await executeTemplateDraftSave(
      await resolveSession(profileName, deps),
      templateId,
      operationId,
    ),
    output,
  );
}

export async function discardTemplateDraft(
  profileName: string | undefined,
  templateId: string,
  operationId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  printResult(
    await executeTemplateDraftDiscard(
      await resolveSession(profileName, deps),
      templateId,
      operationId,
    ),
    output,
  );
}

/** Preflights against Core and binds the eventual Collab apply to that exact catalog revision. */
export async function executeTemplateApply(
  session: Session,
  input: TemplateApplyOptions,
  makeId: () => string = randomUUID,
  options: { readonly waitForFileTransfer?: boolean } = {},
): Promise<unknown> {
  const idempotencyKey =
    input.idempotencyKey ?? `nixctl-template-apply:${input.templateId}:${makeId()}`;
  let revision = input.expectedRevision;
  let preflight: unknown = null;
  let applicationAttempted = false;
  try {
    if (input.idempotencyKey !== undefined && input.expectedRevision === undefined) {
      throw new Error(
        'A template application resume needs the original expected revision; provide both --idempotency-key and --expected-revision.',
      );
    }
    if (input.idempotencyKey === undefined) {
      const detail = await session.client.query(templateResources.templateById(input.templateId));
      revision ??= detail.revision;
      const preview = await session.client.execute(
        templateResources.preflightTemplate(input.templateId, {
          mode: input.mode,
          ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId }),
          ...(input.parentItemId === undefined ? {} : { parentItemId: input.parentItemId }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
          expectedRevision: revision,
        }),
      );
      if (!preview.canApply) {
        const refusal =
          preview.conflicts.length === 0
            ? 'Core refused this template application.'
            : preview.conflicts.join(' ');
        throw new Error(refusal);
      }
      revision = preview.templateRevision;
      preflight = preview;
    }

    const application: TemplateApplicationRequest = {
      templateId: input.templateId,
      mode: input.mode,
      ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId }),
      ...(input.parentItemId === undefined ? {} : { parentItemId: input.parentItemId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      ...(revision === undefined ? {} : { expectedRevision: revision }),
      idempotencyKey,
    };
    applicationAttempted = true;
    const collab = collabClientFor(session);
    const endpoint = templateResources.applyTemplate(application);
    const first = await collab.execute(endpoint);
    if (options.waitForFileTransfer === false && first.fileTransferPending === true) {
      return {
        preflight,
        application: first,
        resume: {
          kind: 'apply',
          jobId: first.fileTransferJobId,
          operationId: first.operationId,
          idempotencyKey,
          expectedRevision: revision ?? null,
          request: application,
        },
      };
    }
    const result = await templateResources.resumeTemplateFileTransfer(session.client, first, () =>
      collab.execute(endpoint),
    );
    return {
      preflight,
      application: result,
      resume: {
        idempotencyKey,
        expectedRevision: revision ?? null,
        request: {
          templateId: input.templateId,
          mode: input.mode,
          ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId }),
          ...(input.parentItemId === undefined ? {} : { parentItemId: input.parentItemId }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
        },
      },
    };
  } catch (error) {
    if (input.idempotencyKey !== undefined || !applicationAttempted) throw error;
    const revisionHint = revision === undefined ? '' : ` --expected-revision ${String(revision)}`;
    const cause = error instanceof Error ? error.message : 'The application result is unknown.';
    throw new Error(
      `${cause} If Core accepted this request, retry the identical template arguments with --idempotency-key ${idempotencyKey}${revisionHint}.`,
      { cause: error },
    );
  }
}

export async function executeTemplateInitializationUpdate(
  session: Session,
  templateId: string,
  initialization: TemplateInitialization,
  options: {
    readonly title?: string;
    readonly description?: string | null;
    readonly idempotencyKey?: string;
  } = {},
  makeId: () => string = randomUUID,
  waitForFiles = true,
): Promise<unknown> {
  const idempotencyKey = options.idempotencyKey ?? `nixctl-template-edit:${templateId}:${makeId()}`;
  const catalogEntry = await session.client.query(templateResources.templateById(templateId));
  const collab = collabClientFor(session);
  try {
    const beginEndpoint = templateResources.beginTemplateDraft(templateId, idempotencyKey);
    const firstDraft = await collab.execute(beginEndpoint);
    if (!waitForFiles && firstDraft.fileTransferPending) {
      return {
        draft: firstDraft,
        resume: {
          kind: 'draft',
          jobId: firstDraft.fileTransferJobId,
          operationId: firstDraft.operationId,
          idempotencyKey,
          request: {
            templateId,
            idempotencyKey,
            workspaceId: catalogEntry.workspaceId,
            metadataPatch: {
              initialization,
              ...(options.title === undefined ? {} : { title: options.title }),
              ...(options.description === undefined ? {} : { description: options.description }),
            },
          },
        },
      };
    }
    const draft = await templateResources.resumeTemplateFileTransfer(
      session.client,
      firstDraft,
      () => collab.execute(beginEndpoint),
    );
    await collab.execute(
      templateResources.updateTemplateDraft(templateId, draft.operationId, {
        initialization,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.description === undefined ? {} : { description: options.description }),
      }),
    );
    await collab.execute(
      templateResources.saveTemplateDraft(templateId, catalogEntry.workspaceId, draft.operationId),
    );
    const saved = await session.client.query(templateResources.templateById(templateId), {
      forceRefresh: true,
    });
    return { template: saved, resume: { idempotencyKey, initialization, ...options } };
  } catch (error) {
    if (options.idempotencyKey !== undefined) throw error;
    const cause =
      error instanceof Error ? error.message : 'The template update could not be confirmed.';
    throw new Error(
      `${cause} If the draft is still active, retry with --idempotency-key ${idempotencyKey} and the same initialization JSON.`,
      { cause: error },
    );
  }
}

export async function listTemplates(
  profileName: string | undefined,
  workspaceId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const catalog = await session.client.query(templateResources.listTemplates(workspaceId));
  printResult(catalog, output);
}

export async function getTemplate(
  profileName: string | undefined,
  templateId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await session.client.query(templateResources.templateById(templateId)), output);
}

export async function captureTemplate(
  profileName: string | undefined,
  input: Omit<TemplateCaptureRequest, 'idempotencyKey'> & {
    readonly idempotencyKey?: string | undefined;
  },
  output: OutputOptions,
  deps: SessionDeps = {},
  makeId: () => string = randomUUID,
  waitForFiles = true,
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const idempotencyKey =
    input.idempotencyKey ?? `nixctl-template-capture:${input.sourceItemId}:${makeId()}`;
  const request: TemplateCaptureRequest = {
    ...input,
    idempotencyKey,
  };
  try {
    const result = await executeTemplateCapture(session, request, waitForFiles);
    printResult(
      {
        capture: result,
        resume: result.fileTransferPending
          ? {
              kind: 'capture',
              jobId: result.fileTransferJobId,
              operationId: result.operationId,
              idempotencyKey,
              request,
            }
          : { idempotencyKey, request },
      },
      output,
    );
  } catch (error) {
    if (input.idempotencyKey !== undefined) throw error;
    const cause =
      error instanceof Error ? error.message : 'The capture result could not be confirmed.';
    throw new Error(
      `${cause} If Core accepted this capture, retry with --idempotency-key ${idempotencyKey} and the same capture options.`,
      { cause: error },
    );
  }
}

export async function applyTemplate(
  profileName: string | undefined,
  input: TemplateApplyOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
  waitForFileTransfer = true,
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(
    await executeTemplateApply(session, input, randomUUID, { waitForFileTransfer }),
    output,
  );
}

export async function resumeTemplateOperation(
  profileName: string | undefined,
  receiptPath: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
    kind: 'capture' | 'apply' | 'draft';
    jobId: string;
    request: unknown;
  };
  if (!['capture', 'apply', 'draft'].includes(receipt.kind) || typeof receipt.jobId !== 'string') {
    throw new TypeError('The template resume receipt is invalid.');
  }
  printResult(
    await executeTemplateOperationResume(await resolveSession(profileName, deps), receipt),
    output,
  );
}

export async function updateTemplateInitialization(
  profileName: string | undefined,
  templateId: string,
  initializationPath: string,
  options: {
    readonly title?: string;
    readonly description?: string | null;
    readonly idempotencyKey?: string;
  },
  output: OutputOptions,
  deps: SessionDeps = {},
  waitForFiles = true,
): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(initializationPath, 'utf8'));
  const initialization = templateInitializationSchema.parse(raw);
  const session = await resolveSession(profileName, deps);
  printResult(
    await executeTemplateInitializationUpdate(
      session,
      templateId,
      initialization,
      options,
      randomUUID,
      waitForFiles,
    ),
    output,
  );
}

export async function preflightTemplate(
  profileName: string | undefined,
  input: TemplatePreflightOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  // Resolves the preview against the current revision unless the caller pins one explicitly.
  const session = await resolveSession(profileName, deps);
  const detail = await session.client.query(templateResources.templateById(input.templateId));
  const preview = await session.client.execute(
    templateResources.preflightTemplate(input.templateId, {
      mode: input.mode,
      ...(input.targetItemId === undefined ? {} : { targetItemId: input.targetItemId }),
      ...(input.parentItemId === undefined ? {} : { parentItemId: input.parentItemId }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
      expectedRevision: input.expectedRevision ?? detail.revision,
    }),
  );
  printResult(preview, output);
}

export async function previewTemplateArchive(
  profileName: string | undefined,
  workspaceId: string,
  archivePath: string,
  options: { readonly idempotencyKey?: string | undefined },
  output: OutputOptions,
  deps: SessionDeps = {},
  makeId: () => string = randomUUID,
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const idempotencyKey = options.idempotencyKey ?? `nixctl-template-import:${makeId()}`;
  try {
    printResult(
      await executeTemplateArchivePreview(session, workspaceId, archivePath, idempotencyKey),
      output,
    );
  } catch (error) {
    if (options.idempotencyKey !== undefined) throw error;
    const cause =
      error instanceof Error ? error.message : 'The archive preview could not be confirmed.';
    throw new Error(
      `${cause} If Core accepted this upload, retry with --idempotency-key ${idempotencyKey}.`,
      { cause: error },
    );
  }
}

export async function commitTemplateArchive(
  profileName: string | undefined,
  importId: string,
  digest: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeTemplateArchiveCommit(session, importId, digest), output);
}

export async function getTemplateImport(
  profileName: string | undefined,
  importId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeTemplateImportGet(session, importId), output);
}

export async function cancelTemplateArchiveImport(
  profileName: string | undefined,
  importId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeTemplateImportCancel(session, importId), output);
}

export async function exportTemplateArchive(
  profileName: string | undefined,
  templateId: string,
  outputPath: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  printResult(await executeTemplateArchiveExport(session, templateId, outputPath), output);
}
