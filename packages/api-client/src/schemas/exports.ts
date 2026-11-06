import { z } from 'zod';
import type { components } from '../generated/api.js';

const nonNegativeIntegerSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(?:0|[1-9]\d*)$/),
]);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const exportStatusSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);

export const exportFormatSchema = z.object({
  format: z.string().min(1),
  label: z.string().min(1),
  extension: z.string().min(1),
  mediaType: z.string().min(1),
  lossless: z.boolean(),
  declaredLoss: z.array(z.string()),
});

export const exportFormatCatalogSchema = z.object({
  formats: z.array(exportFormatSchema),
  observedAt: z.iso.datetime({ offset: true }),
});

export const exportSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  workspaceId: z.uuid(),
  format: z.string().min(1),
  scope: z.enum(['item', 'subtree']),
  fileName: z.string().min(1),
  mediaType: z.string().min(1),
  status: exportStatusSchema,
  itemCount: nonNegativeIntegerSchema.nullable(),
  omittedCount: nonNegativeIntegerSchema.nullable(),
  byteLength: nonNegativeIntegerSchema.nullable(),
  sha256: digestSchema.nullable(),
  loss: z.array(z.string()),
  omissions: z.array(z.string()),
  failureCode: z.string().nullable(),
  failureDetail: z.string().nullable(),
  cancellationRequested: z.boolean(),
  downloadReady: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** The file upload an export-to-file produced. */
  uploadId: z.uuid().nullable().exactOptional(),
});

export const exportDownloadCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  fileName: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: nonNegativeIntegerSchema,
  sha256: digestSchema,
});

export type ExportStatus = z.infer<typeof exportStatusSchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type ExportFormatCatalog = z.infer<typeof exportFormatCatalogSchema>;
export type Export = z.infer<typeof exportSchema>;
export type ExportDownloadCapability = z.infer<typeof exportDownloadCapabilitySchema>;

const _formatContract = exportFormatSchema satisfies z.ZodType<
  components['schemas']['ExportFormatResponse']
>;
const _catalogContract = exportFormatCatalogSchema satisfies z.ZodType<
  components['schemas']['ExportFormatCatalogResponse']
>;
const _exportContract = exportSchema satisfies z.ZodType<components['schemas']['ExportResponse']>;
const _downloadContract = exportDownloadCapabilitySchema satisfies z.ZodType<
  components['schemas']['ExportDownloadCapabilityResponse']
>;
void [_formatContract, _catalogContract, _exportContract, _downloadContract];
