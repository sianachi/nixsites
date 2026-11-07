/** The workspace attachments list, per-file version state and public links, for the page and for agents alike. */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  attachmentRowSchema,
  publicLinkSchema,
  type AttachmentRow,
  type FileVersionState,
  type PublicLink,
} from '../schemas/attachments.js';
import { cursorPageSchema, noContentSchema, type CursorPage } from '../schemas/index.js';
import { z } from 'zod';

export interface AttachmentFilter {
  readonly state?: FileVersionState | undefined;
  readonly includeImages?: boolean | undefined;
  readonly expiring?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/** One page of file items, newest first. Images only when asked for. */
export const listAttachments = (
  workspaceId: string,
  filter: AttachmentFilter = {},
): QueryEndpoint<CursorPage<AttachmentRow>> =>
  defineQuery<CursorPage<AttachmentRow>>({
    operation: 'attachments.list',
    path: `/api/v1/workspaces/${workspaceId}/attachments`,
    query: {
      state: filter.state,
      includeImages: filter.includeImages === true ? true : undefined,
      expiring: filter.expiring === true ? true : undefined,
      limit: filter.limit,
      cursor: filter.cursor,
    },
    schema: cursorPageSchema(attachmentRowSchema),
    cacheKey: ['attachments', workspaceId, JSON.stringify(filter)],
    staleAfterMs: 0,
  });

/** Moves a file version between draft, in review, approved and revoked. */
export const setVersionState = (
  itemId: string,
  versionId: string,
  state: FileVersionState,
): CommandEndpoint<unknown> =>
  defineCommand<unknown>({
    operation: 'files.versions.state',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/file/versions/${versionId}/state`,
    schema: z.unknown(),
    body: { state },
    invalidates: [['files', itemId], ['items', itemId], ['attachments']],
  });

/** The active public link of a file, or a 404 when there is none (or links are off). */
export const getPublicLink = (itemId: string): QueryEndpoint<PublicLink> =>
  defineQuery<PublicLink>({
    operation: 'publicLinks.get',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: publicLinkSchema,
    cacheKey: ['items', itemId, 'public-link'],
    staleAfterMs: 0,
  });

/** Creates the link; with no version it serves the latest approved one. */
export const createPublicLink = (itemId: string, versionId?: string): CommandEndpoint<PublicLink> =>
  defineCommand<PublicLink>({
    operation: 'publicLinks.create',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: publicLinkSchema,
    body: versionId === undefined ? {} : { versionId },
    invalidates: [['items', itemId, 'public-link'], ['attachments']],
  });

export const revokePublicLink = (itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'publicLinks.revoke',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: noContentSchema,
    invalidates: [['items', itemId, 'public-link'], ['attachments']],
  });
