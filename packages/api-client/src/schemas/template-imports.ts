import { z } from 'zod';

export const templateImportDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const templateImportProfileSchema = z.object({
  kind: z.literal('template'),
  version: z.literal(1),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  includeBody: z.boolean(),
  includeChildren: z.boolean(),
});

export const templateImportPreviewSchema = z.object({
  profile: templateImportProfileSchema,
  digest: templateImportDigestSchema,
  rootItemType: z.string(),
  itemCount: z.number().int().positive(),
  bodyCount: z.number().int().nonnegative(),
  viewCount: z.number().int().nonnegative(),
});

const templateImportResultSchema = z.object({
  operationId: z.uuid().nullable(),
  templateId: z.uuid(),
  stableKey: z.string(),
  digest: templateImportDigestSchema,
  unchanged: z.boolean(),
  writtenTargetItemIds: z.array(z.uuid()),
});

export const templateImportUploadSchema = z.object({
  id: z.uuid(),
  status: z.string().min(1),
  uploadUrl: z.url().nullable(),
  capabilityExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});

export const templateImportSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  status: z.string().min(1),
  previewOperationId: z.uuid().nullable(),
  commitOperationId: z.uuid().nullable(),
  preview: templateImportPreviewSchema.nullable(),
  result: templateImportResultSchema.nullable(),
  failureCode: z.string().nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type TemplateImport = z.infer<typeof templateImportSchema>;
export type TemplateImportPreview = z.infer<typeof templateImportPreviewSchema>;
export type TemplateImportProfile = z.infer<typeof templateImportProfileSchema>;
export type TemplateImportResult = z.infer<typeof templateImportResultSchema>;
export type TemplateImportUpload = z.infer<typeof templateImportUploadSchema>;
