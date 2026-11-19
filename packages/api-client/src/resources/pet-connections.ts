import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';

const actionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  resourceKind: z.string(),
  kind: z.enum(['read', 'write']),
  description: z.string(),
  schema: z.json(),
  schemaHash: z.string(),
  configured: z.boolean(),
});

const connectionSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  resourceKind: z.string(),
  resourceId: z.string(),
  actions: z.array(z.string()),
  revision: z.uuid(),
});

const calendarSchema = z.object({
  linkId: z.uuid(),
  provider: z.string(),
  resourceId: z.string(),
  name: z.string(),
  writable: z.boolean(),
});

const listSchema = z.object({
  enabled: z.boolean(),
  connections: z.array(connectionSchema),
  actions: z.array(actionSchema),
  calendars: z.array(calendarSchema).default([]),
});

const authorizationSchema = z.object({
  authorizationUrl: z.url({ protocol: /^https?$/ }),
});

export type PetServiceConnection = z.infer<typeof connectionSchema>;
export type PetConnectionList = z.infer<typeof listSchema>;
type PetConnectionAuthorization = z.infer<typeof authorizationSchema>;
export interface AuthorizePetConnection {
  readonly provider: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly actions: readonly string[];
  readonly returnTo?: string;
  readonly calendarLinkId?: string;
}

const path = (workspaceId: string) =>
  `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pet-connections`;
const key = (workspaceId: string) => ['workspaces', workspaceId, 'pet-connections'];

export const list = (workspaceId: string): QueryEndpoint<PetConnectionList> =>
  defineQuery({
    operation: 'petConnections.list',
    path: path(workspaceId),
    schema: listSchema,
    cacheKey: key(workspaceId),
    staleAfterMs: 0,
    retain: false,
  });

export const authorize = (
  workspaceId: string,
  body: AuthorizePetConnection,
): CommandEndpoint<PetConnectionAuthorization> =>
  defineCommand({
    operation: 'petConnections.authorize',
    method: 'POST',
    path: `${path(workspaceId)}/authorize`,
    schema: authorizationSchema,
    body,
  });

export const disconnect = (workspaceId: string, connectionId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'petConnections.disconnect',
    method: 'DELETE',
    path: `${path(workspaceId)}/${encodeURIComponent(connectionId)}`,
    schema: noContentSchema,
    invalidates: [key(workspaceId)],
  });

export interface RegisterPetMcpConnection {
  readonly url: string;
  readonly tool: string;
  readonly token: string;
}

export const registerMcp = (
  workspaceId: string,
  body: RegisterPetMcpConnection,
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'petConnections.registerMcp',
    method: 'POST',
    path: `${path(workspaceId)}/register-mcp`,
    schema: noContentSchema,
    body,
    invalidates: [key(workspaceId)],
  });
