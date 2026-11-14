import { z } from 'zod';
import type { components } from '../generated/api.js';

type AttachmentRowContract = components['schemas']['AttachmentRow'];
type ReferencedByContract = components['schemas']['ItemReferencedByResponse'];
type PublicLinkContract = components['schemas']['PublicLinkResponse'];

/** The four states a file version moves through. */
export const fileVersionStateSchema = z.enum(['draft', 'in_review', 'approved', 'revoked']);
export type FileVersionState = z.infer<typeof fileVersionStateSchema>;

/** One file item in the workspace attachments list. It carries whether a link exists, never its URL. */
export const attachmentRowSchema = z.object({
  itemId: z.uuid(),
  title: z.string(),
  mediaType: z.string(),
  shownVersionId: z.uuid(),
  shownVersionState: fileVersionStateSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  sourceItemId: z.uuid().nullable(),
  pinCount: z.number().int().nonnegative(),
  hasPublicLink: z.boolean(),
  /** Whether the file has review states switched on; off means no Draft, In review or Approved wording. */
  reviewStates: z.boolean().default(false),
}) satisfies z.ZodType<Omit<AttachmentRowContract, 'shownVersionState' | 'pinCount'> & object>;

export type AttachmentRow = z.infer<typeof attachmentRowSchema>;

/** A holder that pins or mentions a file. A pin names a version; a mention does not. */
export const referencedBySchema = z.object({
  id: z.uuid(),
  holderItemId: z.uuid(),
  holderTitle: z.string().nullable(),
  holderAvailable: z.boolean(),
  targetItemId: z.uuid(),
  targetFileVersionId: z.uuid().nullable(),
  role: z.string().nullable(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<Omit<ReferencedByContract, never>>;

export type ReferencedBy = z.infer<typeof referencedBySchema>;

/** A file's active public link. The URL is only ever read from here, never from a list row. */
export const publicLinkSchema = z.object({
  url: z.string(),
  itemId: z.uuid(),
  versionId: z.uuid().nullable(),
  versionState: z.string().nullable(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime({ offset: true }),
  /** Files a note links to that the link withholds because no version is approved. */
  withheldFiles: z.array(z.object({ fileItemId: z.uuid(), name: z.string() })).default([]),
}) satisfies z.ZodType<PublicLinkContract>;

export type PublicLink = z.infer<typeof publicLinkSchema>;
