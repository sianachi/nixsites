import { z } from 'zod';

export const commentSchema = z.object({
  id: z.uuid(),
  authorId: z.uuid(),
  /** The importer's name when `importedAuthor` is set. */
  authorName: z.string(),
  /** The original author's name when the comment came from a `.nix` archive. */
  importedAuthor: z.string().nullable(),
  body: z.string(),
  mentionIds: z.array(z.uuid()),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
  /** True for a tombstone: the author deleted a root that others had replied to. `body` is empty; show "Comment deleted". */
  deleted: z.boolean(),
});

/**
 * A thread: root comment first (its id is the thread id), then replies oldest first. `anchorStart`
 * and `anchorEnd` are base64 Yjs relative positions; both null with a `quote` means the thread
 * waits for a client to anchor it, and all null means a page-level thread.
 */
export const commentThreadSchema = z.object({
  id: z.uuid(),
  anchorStart: z.string().nullable(),
  anchorEnd: z.string().nullable(),
  quote: z.string().nullable(),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  resolvedBy: z.uuid().nullable(),
  resolvedByName: z.string().nullable(),
  comments: z.array(commentSchema),
});

export const commentsResponseSchema = z.object({
  revision: z.number().int().min(0),
  threads: z.array(commentThreadSchema),
  canComment: z.boolean(),
});

export type Comment = z.infer<typeof commentSchema>;
export type CommentThread = z.infer<typeof commentThreadSchema>;
export type CommentsResponse = z.infer<typeof commentsResponseSchema>;
