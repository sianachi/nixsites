import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  commentThreadSchema,
  commentsResponseSchema,
  type CommentThread,
  type CommentsResponse,
} from '../schemas/comments.js';
import { noContentSchema } from '../schemas/index.js';

export interface CommentAnchorInput {
  /** Base64 Yjs relative positions; give both or neither. */
  readonly start?: string | null;
  readonly end?: string | null;
  /** The commented text, kept to re-anchor after the positions are lost. */
  readonly quote?: string | null;
}

export interface AddCommentInput {
  readonly body: string;
  readonly mentionIds?: readonly string[];
  /** Omit for a page-level comment. */
  readonly anchor?: CommentAnchorInput;
}

export interface ReplyCommentInput {
  readonly body: string;
  readonly mentionIds?: readonly string[];
}

const commentsPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/comments`;
const commentsKey = (itemId: string) => ['items', itemId, 'comments'] as const;

export const list = (itemId: string): QueryEndpoint<CommentsResponse> =>
  defineQuery({
    operation: 'comments.list',
    path: commentsPath(itemId),
    cacheKey: commentsKey(itemId),
    schema: commentsResponseSchema,
  });

/**
 * The GET long-poll counterpart to `list`: answers when the note's comment revision passes
 * `revision`, or after about 20 seconds with the current state. The server bounds how many of
 * these one principal may hold open (429 `comments.too_many_watches`).
 */
export const watch = (itemId: string, revision: number): QueryEndpoint<CommentsResponse> =>
  defineQuery({
    operation: 'comments.watch',
    path: `${commentsPath(itemId)}/watch`,
    schema: commentsResponseSchema,
    query: { revision },
  });

export const add = (itemId: string, input: AddCommentInput): CommandEndpoint<CommentThread> =>
  defineCommand({
    operation: 'comments.add',
    method: 'POST',
    path: commentsPath(itemId),
    body: input,
    schema: commentThreadSchema,
    invalidates: [commentsKey(itemId)],
  });

export const reply = (
  itemId: string,
  threadId: string,
  input: ReplyCommentInput,
): CommandEndpoint<CommentThread> =>
  defineCommand({
    operation: 'comments.reply',
    method: 'POST',
    path: `${commentsPath(itemId)}/${encodeURIComponent(threadId)}/replies`,
    body: input,
    schema: commentThreadSchema,
    invalidates: [commentsKey(itemId)],
  });

/** Author only. */
export const edit = (
  itemId: string,
  commentId: string,
  body: string,
): CommandEndpoint<CommentThread> =>
  defineCommand({
    operation: 'comments.edit',
    method: 'PATCH',
    path: `${commentsPath(itemId)}/${encodeURIComponent(commentId)}`,
    body: { body },
    schema: commentThreadSchema,
    invalidates: [commentsKey(itemId)],
  });

/** Re-anchors a thread to fresh relative positions after its anchor was lost. */
export const setAnchor = (
  itemId: string,
  threadId: string,
  start: string,
  end: string,
): CommandEndpoint<CommentThread> =>
  defineCommand({
    operation: 'comments.setAnchor',
    method: 'PUT',
    path: `${commentsPath(itemId)}/${encodeURIComponent(threadId)}/anchor`,
    body: { start, end },
    schema: commentThreadSchema,
    invalidates: [commentsKey(itemId)],
  });

export const setResolved = (
  itemId: string,
  threadId: string,
  resolved: boolean,
): CommandEndpoint<CommentThread> =>
  defineCommand({
    operation: 'comments.setResolved',
    method: 'PUT',
    path: `${commentsPath(itemId)}/${encodeURIComponent(threadId)}/resolved`,
    body: { resolved },
    schema: commentThreadSchema,
    invalidates: [commentsKey(itemId)],
  });

/** Author only. Deleting a thread's root deletes the whole thread. */
export const remove = (itemId: string, commentId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'comments.remove',
    method: 'DELETE',
    path: `${commentsPath(itemId)}/${encodeURIComponent(commentId)}`,
    schema: noContentSchema,
    invalidates: [commentsKey(itemId)],
  });
