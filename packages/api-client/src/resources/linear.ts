import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import { noContentSchema } from '../schemas/index.js';

type Schemas = components['schemas'];

const connectionSchema = z.object({
  connected: z.boolean(),
}) satisfies z.ZodType<Schemas['LinearConnectionResponse']>;

const authorizationSchema = z.object({
  authorizationUrl: z.string(),
}) satisfies z.ZodType<Schemas['LinearAuthorizationResponse']>;

const issueSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  url: z.string(),
}) satisfies z.ZodType<Schemas['LinearIssueResponse']>;

const requestSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  issueId: z.string(),
  status: z.enum(['pending', 'running', 'declined', 'succeeded', 'failed', 'unknown', 'expired']),
  requestedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  canDecide: z.boolean(),
  result: issueSchema.nullable().default(null),
  petId: z.uuid().nullable().default(null),
  commentId: z.uuid().nullable().default(null),
}) satisfies z.ZodType<Schemas['LinearRequestResponse']>;

const requestsSchema = z.object({
  requests: z.array(requestSchema),
  canHandToPet: z.boolean().default(false),
}) satisfies z.ZodType<Schemas['LinearRequestsResponse']>;

const linkedIssueSchema = z.object({
  revision: z.uuid(),
  connected: z.boolean(),
  identifier: z.string().nullable().default(null),
  url: z
    .url({ protocol: /^https$/, hostname: /^linear\.app$/ })
    .nullable()
    .default(null),
  remoteStatus: z.string().nullable().default(null),
  checkedAt: z.string().nullable().default(null),
  localStatus: z.string().nullable().default(null),
  change: z.enum(['none', 'remote', 'local', 'conflict']).nullable().default(null),
  canCopyStatus: z.boolean(),
}) satisfies z.ZodType<Schemas['LinearLinkedIssue']>;

const linkSchema = z.object({
  link: linkedIssueSchema.nullable().default(null),
  connections: z.array(z.object({ id: z.uuid(), teamId: z.uuid() })),
}) satisfies z.ZodType<Schemas['LinearLinkResponse']>;

export type LinearRequestResponse = z.infer<typeof requestSchema>;
export type LinearIssueResponse = z.infer<typeof issueSchema>;
export type LinearLinkResponse = z.infer<typeof linkSchema>;

const connectionPath = (workspaceId: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/linear`;
const requestsPath = (itemId: string) =>
  `/api/v1/items/${encodeURIComponent(itemId)}/linear-requests`;
const requestPath = (itemId: string, requestId: string) =>
  `${requestsPath(itemId)}/${encodeURIComponent(requestId)}`;
const connectionKey = (workspaceId: string) => ['workspaces', workspaceId, 'linear'];
const requestsKey = (itemId: string) => ['items', itemId, 'linear-requests'];
const linkPath = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/linear-link`;
const linkKey = (itemId: string) => ['items', itemId, 'linear-link'];

export const getLink = (itemId: string): QueryEndpoint<LinearLinkResponse> =>
  defineQuery({
    operation: 'linear.getLink',
    path: linkPath(itemId),
    schema: linkSchema,
    cacheKey: linkKey(itemId),
    staleAfterMs: 0,
  });

export const linkIssue = (
  itemId: string,
  connectionId: string,
  issue: string,
): CommandEndpoint<LinearLinkResponse> =>
  defineCommand({
    operation: 'linear.linkIssue',
    method: 'PUT',
    path: linkPath(itemId),
    schema: linkSchema,
    body: { connectionId, issue } satisfies Schemas['LinkLinearIssueRequest'],
    invalidates: [linkKey(itemId)],
    timeoutMs: 80_000,
  });

export const refreshLink = (itemId: string): CommandEndpoint<LinearLinkResponse> =>
  defineCommand({
    operation: 'linear.refreshLink',
    method: 'POST',
    path: `${linkPath(itemId)}/refresh`,
    schema: linkSchema,
    invalidates: [linkKey(itemId)],
    timeoutMs: 80_000,
  });

export const copyLinkedStatus = (
  itemId: string,
  revision: string,
  localStatus: string | null,
): CommandEndpoint<LinearLinkResponse> =>
  defineCommand({
    operation: 'linear.copyLinkedStatus',
    method: 'POST',
    path: `${linkPath(itemId)}/copy-status`,
    schema: linkSchema,
    body: { revision, localStatus } satisfies Schemas['CopyLinearStatusRequest'],
    invalidates: [['items', itemId]],
  });

export const unlinkIssue = (itemId: string, revision: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'linear.unlinkIssue',
    method: 'DELETE',
    path: linkPath(itemId),
    query: { revision },
    schema: noContentSchema,
    invalidates: [linkKey(itemId)],
  });

export const getConnection = (
  workspaceId: string,
): QueryEndpoint<z.infer<typeof connectionSchema>> =>
  defineQuery({
    operation: 'linear.getConnection',
    path: connectionPath(workspaceId),
    schema: connectionSchema,
    cacheKey: connectionKey(workspaceId),
    staleAfterMs: 0,
  });

export const authorize = (
  workspaceId: string,
  returnTo?: string,
): CommandEndpoint<z.infer<typeof authorizationSchema>> =>
  defineCommand({
    operation: 'linear.authorize',
    method: 'POST',
    path: `${connectionPath(workspaceId)}/authorize`,
    schema: authorizationSchema,
    body: { returnTo: returnTo ?? null } satisfies Schemas['AuthorizeLinearConnectionRequest'],
  });

export const disconnect = (workspaceId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'linear.disconnect',
    method: 'DELETE',
    path: connectionPath(workspaceId),
    schema: noContentSchema,
    invalidates: [connectionKey(workspaceId)],
  });

export const listRequests = (itemId: string): QueryEndpoint<z.infer<typeof requestsSchema>> =>
  defineQuery({
    operation: 'linear.listRequests',
    path: requestsPath(itemId),
    schema: requestsSchema,
    cacheKey: requestsKey(itemId),
    staleAfterMs: 0,
  });

export const requestIssue = (
  itemId: string,
  issueId: string,
): CommandEndpoint<LinearRequestResponse> =>
  defineCommand({
    operation: 'linear.requestIssue',
    method: 'POST',
    path: requestsPath(itemId),
    schema: requestSchema,
    body: { issueId } satisfies Schemas['RequestLinearIssueRequest'],
    invalidates: [requestsKey(itemId)],
  });

export const handToPet = (
  itemId: string,
  petId: string,
  issueId: string,
): CommandEndpoint<LinearRequestResponse> =>
  defineCommand({
    operation: 'linear.handToPet',
    method: 'POST',
    path: `${requestsPath(itemId)}/hand-to-pet`,
    schema: requestSchema,
    body: { petId, issueId } satisfies Schemas['HandToPetRequest'],
    invalidates: [requestsKey(itemId)],
  });

export const getRequest = (
  itemId: string,
  requestId: string,
): QueryEndpoint<LinearRequestResponse> =>
  defineQuery({
    operation: 'linear.getRequest',
    path: requestPath(itemId, requestId),
    schema: requestSchema,
    cacheKey: [...requestsKey(itemId), requestId],
    staleAfterMs: 0,
  });

export const decide = (
  itemId: string,
  requestId: string,
  approve: boolean,
): CommandEndpoint<LinearRequestResponse> =>
  defineCommand({
    operation: 'linear.decide',
    method: 'POST',
    path: `${requestPath(itemId, requestId)}/decision`,
    schema: requestSchema,
    body: { approve } satisfies Schemas['DecideLinearIssueRequest'],
    invalidates: [requestsKey(itemId)],
    timeoutMs: 80_000,
  });
