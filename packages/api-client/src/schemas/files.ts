import { z } from 'zod';
import type { components } from '../generated/api.js';

/** The pixel size of a version's stored thumbnail. */
const fileThumbnailSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const fileVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  fileName: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  previewable: z.boolean(),
  pixelWidth: z.number().int().positive().nullable(),
  pixelHeight: z.number().int().positive().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  current: z.boolean(),
  // Null when the version has no thumbnail, and the default when an older server omits the field.
  thumbnail: fileThumbnailSchema.nullable().default(null),
  // Optional: an older server omits the lifecycle fields, and the version is then a draft.
  state: z.enum(['draft', 'in_review', 'approved', 'revoked']).optional(),
  stateChangedBy: z.uuid().nullable().optional(),
  stateChangedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  sourceItemId: z.uuid().nullable().optional(),
  sourceSeq: z.number().int().nonnegative().nullable().optional(),
});
export const fileRecordSchema = z.object({
  itemId: z.uuid(),
  workspaceId: z.uuid(),
  current: fileVersionSchema,
  versions: z.array(fileVersionSchema),
  // The version the file shows: latest approved, else the current upload.
  shownVersionId: z.uuid().nullable().optional(),
});
export const fileUploadSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  uploadUrl: z.url().nullable(),
  capabilityExpiresAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
  itemId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
});
export const fileUploadStatusSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  itemId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
  /** The version the publish job created; set once the upload completed. */
  publishedVersionId: z.uuid().nullable().exactOptional(),
});
export const fileDownloadCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  fileName: z.string(),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  inline: z.boolean(),
  unscanned: z.boolean(),
  noSniff: z.boolean(),
  // The version served when the request named none.
  versionId: z.uuid().nullable().default(null),
  // The media type the version was stored with; mediaType is the Content-Type the URL is served with.
  storedMediaType: z.string().nullable().default(null),
  // True only for an Owner's audited diagnostic download of a revoked version.
  revoked: z.boolean().nullable().exactOptional(),
});
export const fileThumbnailCapabilitySchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteLength: z.number().int().positive(),
  versionId: z.uuid().nullable().default(null),
});

const _fileThumbnailContract = fileThumbnailSchema satisfies z.ZodType<
  components['schemas']['FileThumbnailRecord']
>;
const _fileThumbnailCapabilityContract = fileThumbnailCapabilitySchema satisfies z.ZodType<
  components['schemas']['FileThumbnailCapabilityResponse']
>;
void _fileThumbnailContract;
void _fileThumbnailCapabilityContract;

export type FileThumbnail = z.infer<typeof fileThumbnailSchema>;
export type FileThumbnailCapability = z.infer<typeof fileThumbnailCapabilitySchema>;
export type FileRecord = z.infer<typeof fileRecordSchema>;
export type FileVersion = z.infer<typeof fileVersionSchema>;
export type FileUpload = z.infer<typeof fileUploadSchema>;
export type FileUploadStatus = z.infer<typeof fileUploadStatusSchema>;
export type FileDownloadCapability = z.infer<typeof fileDownloadCapabilitySchema>;
