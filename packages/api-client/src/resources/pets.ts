import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import type { components } from '../generated/api.js';
import { noContentSchema } from '../schemas/index.js';
import {
  petConnectionSchema,
  petSettingsResponseSchema,
  type PetSettings,
  type PetSettingsResponse,
  type PetConnection,
  petProvidersResponseSchema,
  petProviderKeySchema,
  type PetProvidersResponse,
  type PetProviderKey,
} from '../schemas/pets.js';

const settingsKey = ['me', 'pets', 'settings'] as const;

export const settings = (): QueryEndpoint<PetSettingsResponse> =>
  defineQuery({
    operation: 'pets.settings',
    path: '/api/v1/me/pets/settings',
    schema: petSettingsResponseSchema,
    cacheKey: settingsKey,
  });

export const saveSettings = (
  expectedRevision: number,
  value: PetSettings,
): CommandEndpoint<PetSettingsResponse> =>
  defineCommand({
    operation: 'pets.saveSettings',
    method: 'PUT',
    path: '/api/v1/me/pets/settings',
    schema: petSettingsResponseSchema,
    body: {
      expectedRevision,
      // Settings read from before memory existed carry neither field; Core reads them as none and on.
      settings: { ...value, memories: value.memories ?? null, memoryOff: value.memoryOff ?? false },
    } satisfies components['schemas']['SavePetSettingsRequest'],
    invalidates: [settingsKey],
  });

const providersKey = ['me', 'pets', 'providers'] as const;

/** The owner's stored provider keys, hints only. */
export const providers = (): QueryEndpoint<PetProvidersResponse> =>
  defineQuery({
    operation: 'pets.providers',
    path: '/api/v1/me/pets/providers',
    schema: petProvidersResponseSchema,
    cacheKey: providersKey,
  });

/** Stores or replaces the owner's key for a provider; the key is never returned. */
export const saveProviderKey = (
  provider: 'anthropic' | 'openrouter',
  key: string,
): CommandEndpoint<PetProviderKey> =>
  defineCommand({
    operation: 'pets.saveProviderKey',
    method: 'PUT',
    path: `/api/v1/me/pets/providers/${provider}/key`,
    schema: petProviderKeySchema,
    body: { key } satisfies components['schemas']['SavePetProviderKeyRequest'],
    invalidates: [providersKey],
  });

export const removeProviderKey = (
  provider: 'anthropic' | 'openrouter',
): CommandEndpoint<undefined> =>
  defineCommand({
    operation: 'pets.removeProviderKey',
    method: 'DELETE',
    path: `/api/v1/me/pets/providers/${provider}/key`,
    schema: noContentSchema,
    invalidates: [providersKey],
  });

export const connection = (): QueryEndpoint<PetConnection> =>
  defineQuery({
    operation: 'pets.connection',
    path: '/api/v1/me/pets/connection',
    schema: petConnectionSchema,
    cacheKey: ['me', 'pets', 'connection'],
  });

export interface RuntimeInput {
  readonly operation:
    | 'status'
    | 'connect'
    | 'disconnect'
    | 'models'
    | 'read'
    | 'send'
    | 'interrupt'
    | 'reset'
    | 'tool_claim'
    | 'tool_result'
    | 'history'
    | 'read_history'
    | 'delete_history'
    | 'rename'
    | 'resume_history';
  readonly workspaceId?: string;
  readonly petId?: string;
  readonly requestId?: string;
  readonly text?: string;
  readonly itemId?: string;
  /** More items to attach to a send (five in all, with `itemId`); each gets the same checks. */
  readonly itemIds?: readonly string[];
  readonly sharedText?: string;
  /** With a send: the user message this turn replaces. It and everything after it is dropped. */
  readonly replaceFromMessageId?: string;
  readonly model?: string;
  readonly workspaceAccess?: boolean;
  /** Limits this conversation to one item and its descendants. */
  readonly rootItemId?: string;
  /** Offers reading tools only; Core still checks every request. */
  readonly readOnly?: boolean;
  readonly toolId?: string;
  readonly toolResult?: string;
  readonly toolSuccess?: boolean;
  /** With a tool result: a picture the result carries, as a `data:image/...;base64` URL. */
  readonly toolImage?: string;
  /** With a tool result: the result came from an item under a lock (marks the conversation). */
  readonly toolLockedContent?: boolean;
  /** The archive a `read_history`, `delete_history`, `resume_history` or archived `rename` names. */
  readonly historyId?: string;
  readonly mode?: 'chat' | 'consult';
  /** The owner's own day, `yyyy-MM-dd` in `timeZone`, so the model can resolve relative dates. */
  readonly today?: string;
  /** The owner's IANA time zone. */
  readonly timeZone?: string;
  /** The workspace's main containers, sent with a conversation's first message only. */
  readonly workspaceMap?: readonly PetWorkspaceMapEntry[];
}

/** One container a conversation's first message describes to the model. */
export interface PetWorkspaceMapEntry {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** Left out when the client does not know the container's views. */
  readonly viewKinds?: readonly string[];
}

export const runtime = (input: RuntimeInput): CommandEndpoint<PetConnection> =>
  defineCommand({
    operation: 'pets.runtime',
    method: 'POST',
    path:
      input.rootItemId === undefined ? '/api/v1/me/pets/runtime' : '/api/v1/me/pets/runtime/note',
    schema: petConnectionSchema,
    body: {
      ...input,
      text: input.text ?? '',
      sharedText: input.sharedText ?? '',
      model: input.model ?? '',
      workspaceAccess: input.workspaceAccess ?? false,
      rootItemId: input.rootItemId ?? null,
      itemIds: input.itemIds === undefined ? null : [...input.itemIds],
      replaceFromMessageId: input.replaceFromMessageId ?? null,
      readOnly: input.readOnly ?? false,
      toolId: input.toolId ?? '',
      toolResult: input.toolResult ?? '',
      toolSuccess: input.toolSuccess ?? false,
      toolImage: input.toolImage ?? '',
      toolLockedContent: input.toolLockedContent ?? false,
      mode: input.mode ?? '',
      today: input.today ?? '',
      timeZone: input.timeZone ?? '',
      workspaceMap:
        input.workspaceMap?.map((entry) => ({
          ...entry,
          viewKinds: entry.viewKinds === undefined ? null : [...entry.viewKinds],
        })) ?? null,
    } satisfies components['schemas']['PetRuntimeRequest'],
    invalidates: [['me', 'pets', 'connection']],
  });

export interface WatchRuntimeInput {
  readonly workspaceId: string;
  readonly petId: string;
  readonly rootItemId?: string;
  readonly mode?: 'chat' | 'consult';
  /** The caller's last known revision; the server waits for a change past it. */
  readonly after?: number;
}

/**
 * The GET long-poll counterpart to `runtime`: never a write, never rate limited by the
 * writes policy, and never de-duplicated the way a cached query would be, since each call
 * carries a different `after`.
 */
export const watchRuntime = (input: WatchRuntimeInput): QueryEndpoint<PetConnection> =>
  defineQuery({
    operation: 'pets.watchRuntime',
    // Core waits up to 20 seconds; the ordinary 15-second read budget ends too early.
    timeoutMs: 35_000,
    path:
      input.rootItemId === undefined
        ? '/api/v1/me/pets/runtime/watch'
        : '/api/v1/me/pets/runtime/note/watch',
    schema: petConnectionSchema,
    query: {
      workspaceId: input.workspaceId,
      petId: input.petId,
      ...(input.rootItemId ? { rootItemId: input.rootItemId } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      after: input.after ?? 0,
    },
  });
