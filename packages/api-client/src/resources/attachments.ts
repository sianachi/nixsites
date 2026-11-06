/** The workspace attachments list and the per-file actions its page offers. */

import {
  defineCommand,
  definePagedQuery,
  defineQuery,
  type CommandEndpoint,
  type PagedQueryEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  attachmentRowSchema,
  publicLinkSchema,
  referencedBySchema,
  type AttachmentRow,
  type FileVersionState,
  type PublicLink,
  type ReferencedBy,
} from '../schemas/attachments.js';
import { noContentSchema } from '../schemas/index.js';
import { z } from 'zod';

export interface AttachmentFilter {
  readonly state?: FileVersionState | undefined;
  readonly includeImages?: boolean | undefined;
  readonly expiring?: boolean | undefined;
}

/** File items, newest first. Images only when asked for. */
export const listAttachments = (
  workspaceId: string,
  filter: AttachmentFilter = {},
  pageSize?: number,
): PagedQueryEndpoint<AttachmentRow> =>
  definePagedQuery<AttachmentRow>({
    operation: 'attachments.list',
    path: `/api/v1/workspaces/${workspaceId}/attachments`,
    query: {
      state: filter.state,
      includeImages: filter.includeImages === true ? true : undefined,
      expiring: filter.expiring === true ? true : undefined,
    },
    itemSchema: attachmentRowSchema,
    pageSize,
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
    invalidates: [['files', itemId]],
  });

/** The active public link of a file, or a 404 when there is none (or links are off). */
export const getPublicLink = (itemId: string): QueryEndpoint<PublicLink> =>
  defineQuery<PublicLink>({
    operation: 'publicLinks.get',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: publicLinkSchema,
    staleAfterMs: 0,
  });

/** Creates the link; with no version it serves the latest approved one. */
export const createPublicLink = (itemId: string, versionId?: string): CommandEndpoint<PublicLink> =>
  defineCommand<PublicLink>({
    operation: 'publicLinks.create',
    method: 'PUT',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: publicLinkSchema,
    body: { versionId: versionId ?? null },
  });

export const revokePublicLink = (itemId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'publicLinks.revoke',
    method: 'DELETE',
    path: `/api/v1/items/${itemId}/public-link`,
    schema: noContentSchema,
  });

/** Who points at a file: pins name a version, mentions do not. */
export const listReferencedBy = (
  itemId: string,
  pageSize?: number,
): PagedQueryEndpoint<ReferencedBy> =>
  definePagedQuery<ReferencedBy>({
    operation: 'references.referencedBy',
    path: `/api/v1/items/${itemId}/referenced-by`,
    itemSchema: referencedBySchema,
    pageSize,
  });

/** Removes a reference from its holder, which is how a pin is undone. */
export const removeReference = (
  holderItemId: string,
  referenceId: string,
): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'references.remove',
    method: 'DELETE',
    path: `/api/v1/items/${holderItemId}/references/${referenceId}`,
    schema: noContentSchema,
  });
