import { z } from 'zod';
import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import { noContentSchema } from '../schemas/index.js';

const kindSchema = z.enum(['client', 'claude', 'codex']);
export type PetPeerKind = z.infer<typeof kindSchema>;
const peerSchema = z.object({
  id: z.uuid(),
  petId: z.uuid(),
  workspaceId: z.uuid(),
  itemId: z.uuid(),
  name: z.string(),
  kind: kindSchema,
  expiresAt: z.string(),
  revokedAt: z.string().nullish(),
});
const workSchema = z.object({
  id: z.uuid(),
  peerId: z.uuid(),
  runId: z.uuid(),
  direction: z.enum(['inbound', 'outbound']),
  status: z.enum(['submitted', 'queued', 'running', 'completed', 'failed', 'review_required']),
  result: z.string().nullish(),
  createdAt: z.string(),
});
const listSchema = z.object({ peers: z.array(peerSchema) });
const workListSchema = z.object({ work: z.array(workSchema) });
const registrationSchema = z.object({
  peer: peerSchema,
  endpoint: z.string(),
  credential: z.string(),
});
export type PetPeerRegistration = z.infer<typeof registrationSchema>;
export type PetPeer = z.infer<typeof peerSchema>;
export type PetPeerWork = z.infer<typeof workSchema>;

const path = (itemId: string) => `/api/v1/items/${encodeURIComponent(itemId)}/pet-peers`;
const key = (itemId: string) => ['items', itemId, 'pet-peers'];

export const list = (itemId: string): QueryEndpoint<z.infer<typeof listSchema>> =>
  defineQuery({
    operation: 'petPeers.list',
    path: path(itemId),
    schema: listSchema,
    cacheKey: key(itemId),
  });
export const listWork = (itemId: string): QueryEndpoint<z.infer<typeof workListSchema>> =>
  defineQuery({
    operation: 'petPeers.listWork',
    path: `${path(itemId)}/work`,
    schema: workListSchema,
    cacheKey: [...key(itemId), 'work'],
    staleAfterMs: 0,
  });
export const register = (
  itemId: string,
  name: string,
  kind: PetPeerKind,
): CommandEndpoint<PetPeerRegistration> =>
  defineCommand({
    operation: 'petPeers.register',
    method: 'POST',
    path: path(itemId),
    schema: registrationSchema,
    body: { name, kind, days: 30 },
    invalidates: [key(itemId)],
  });
export const revoke = (itemId: string, peerId: string): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'petPeers.revoke',
    method: 'DELETE',
    path: `${path(itemId)}/${encodeURIComponent(peerId)}`,
    schema: noContentSchema,
    invalidates: [key(itemId)],
  });
