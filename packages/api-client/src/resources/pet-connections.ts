import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';

const connectionSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  resourceKind: z.string(),
  resourceId: z.string(),
  actions: z.array(z.string()),
  revision: z.uuid(),
});

const listSchema = z.object({
  enabled: z.boolean(),
  connections: z.array(connectionSchema),
});

export type PetServiceConnection = z.infer<typeof connectionSchema>;
export type PetConnectionList = z.infer<typeof listSchema>;
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
