/**
 * Every Core operation as data, for the generic "find an action / run an action" tools of the pet,
 * MCP and the CLI. Only operations named in Core's published contract can be called, so this is
 * not a generic `request(method, url)`: the path template, its parameters and the method all come
 * from the catalog, and Core still applies the caller's permissions, locks and token scopes.
 */
import { z } from 'zod';
import type { NixClient } from './client.js';
import { defineCommand, defineQuery } from './endpoints.js';
import { OPERATION_ENTRIES } from './generated/operations.js';
import type { QueryValue } from './http.js';

export interface OperationEntry {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly area: string;
  readonly summary: string;
  readonly detail: string;
  readonly pathParams: readonly string[];
  /** Path parameters the contract types as UUIDs; anything else in them is refused. */
  readonly uuidParams: readonly string[];
  readonly queryParams: readonly { name: string; required: boolean; type: unknown }[];
  readonly body?: unknown;
}

export const OPERATIONS: readonly OperationEntry[] = OPERATION_ENTRIES;

const byId = new Map(OPERATIONS.map((entry) => [entry.id, entry]));

export function operationById(id: string): OperationEntry | undefined {
  return byId.get(id);
}

/**
 * Operations an assistant (the pet, or an MCP client) never runs, whatever it is asked. They mint
 * or replace credentials, change the pet's own settings or runtime, steer other chats, grant
 * tenant-wide powers, or stand in for a human approval. A person still does them in the web app
 * or with `nixctl api`. Mirrors Core's interactive-only routes plus the grants above them.
 */
const HUMAN_ONLY: readonly [RegExp, 'any' | 'write'][] = [
  [/^\/api\/v1\/me\/tokens(\/|$)/, 'any'],
  [/^\/api\/v1\/me\/pets(\/|$)/, 'any'],
  [/^\/api\/v1\/me\/push-subscriptions(\/|$)/, 'any'],
  [/^\/api\/v1\/me\/calendar\/connections(\/|$)/, 'any'],
  [/^\/api\/v1\/me\/(preferences|ui-settings|workspace-arrangement)(\/|$)/, 'write'],
  [/^\/api\/v1\/conversations\/[^/]+\/(turns|configure|sources|cancel)$/, 'write'],
  [/^\/api\/v1\/workspaces\/[^/]+\/conversations(\/|$)/, 'write'],
  [/^\/api\/v1\/tenant\/admins(\/|$)/, 'any'],
  [/^\/api\/v1\/sites\/operators(\/|$)/, 'any'],
  [/\/approval\/(approve|reject)$/, 'any'],
];

export function isHumanOnlyOperation(entry: OperationEntry): boolean {
  return HUMAN_ONLY.some(
    ([pattern, applies]) =>
      pattern.test(entry.path) && (applies === 'any' || entry.method !== 'GET'),
  );
}

/** What an approval card should warn about before this operation runs. */
export type OperationRisk = 'irreversible' | 'access' | 'public' | undefined;

/** Writes Core holds to its admin scope: they change access, act later with the caller's authority
 * (automations, plugins, calendar links), or move items between workspaces. */
const ACCESS_PATHS =
  /\/(members|invitations|sharing|admins|operators|lock|unlock|protection|permissions|roles|recover|leave|archive|restore|plugins|automations|move)(\/|$)|^\/api\/v1\/me\/calendar\/links(?!.*\/sync$)|^\/api\/v1\/workspaces\/\{workspaceId\}\/(archive|restore)$/;

export function operationRisk(entry: OperationEntry): OperationRisk {
  if (entry.method === 'GET') return undefined;
  // DeleteItem only moves the item to the trash; every other delete is final.
  if (/^(Purge|Delete|Unpublish)/.test(entry.id) && entry.id !== 'DeleteItem')
    return 'irreversible';
  if (
    /\/(publish|public-link|approval)(\/|$)/.test(entry.path) ||
    entry.path.startsWith('/api/v1/sites')
  )
    return 'public';
  if (ACCESS_PATHS.test(entry.path) && entry.id !== 'RestoreItem') return 'access';
  return undefined;
}

function words(text: string): string[] {
  return (
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1)
      // Plurals fold onto their singular, so "bookmark" finds the Bookmarks operations.
      .map((word) => (word.length > 3 ? word.replace(/ies$/, 'y').replace(/(?<!s)s$/, '') : word))
  );
}

const indexed = OPERATIONS.map((entry) => ({
  entry,
  strong: new Set([...words(entry.id), ...words(entry.summary), ...words(entry.area)]),
  weak: new Set([...words(entry.path), ...words(entry.detail)]),
}));

/** Rare words decide a match: "bookmark" says more than "note", which half the catalog mentions. */
const rarity = new Map<string, number>();
for (const { strong, weak } of indexed)
  for (const word of new Set([...strong, ...weak])) rarity.set(word, (rarity.get(word) ?? 0) + 1);

/** Operations matching a plain-language request, best first; ties keep catalog order. */
export function findOperations(
  query: string,
  limit = 8,
  include: (entry: OperationEntry) => boolean = () => true,
): OperationEntry[] {
  const wanted = new Set(words(query));
  if (wanted.size === 0) return [];
  return indexed
    .filter(({ entry }) => include(entry))
    .map(({ entry, strong, weak }) => {
      let score = 0;
      for (const word of wanted) {
        const weight = Math.log(1 + OPERATIONS.length / (rarity.get(word) ?? OPERATIONS.length));
        score += strong.has(word) ? 3 * weight : weak.has(word) ? weight : 0;
      }
      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export interface OperationCall {
  readonly path?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly body?: unknown;
}

export class OperationCallError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request an operation call would send, without sending it. */
export function operationRequest(
  entry: OperationEntry,
  call: OperationCall,
): { method: string; path: string; query: Record<string, QueryValue> } {
  const params = call.path ?? {};
  for (const name of Object.keys(params))
    if (!entry.pathParams.includes(name))
      throw new OperationCallError(`${entry.id} has no path parameter '${name}'.`);
  const path = entry.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '')
      throw new OperationCallError(`${entry.id} needs the path parameter '${name}'.`);
    // One path segment, never a traversal: URL parsing would fold "." and ".." into another route.
    if (value === '.' || value === '..' || (entry.uuidParams.includes(name) && !UUID.test(value)))
      throw new OperationCallError(`${entry.id}: '${name}' is not a valid ${name}.`);
    return encodeURIComponent(value);
  });
  const query: Record<string, QueryValue> = {};
  for (const [name, value] of Object.entries(call.query ?? {})) {
    if (!entry.queryParams.some((param) => param.name === name))
      throw new OperationCallError(`${entry.id} has no query parameter '${name}'.`);
    query[name] = value;
  }
  for (const param of entry.queryParams)
    if (param.required && query[param.name] === undefined)
      throw new OperationCallError(`${entry.id} needs the query parameter '${param.name}'.`);
  if (call.body !== undefined && entry.body === undefined)
    throw new OperationCallError(`${entry.id} takes no request body.`);
  return { method: entry.method, path, query };
}

/** Runs one catalog operation as the client's caller and returns Core's JSON answer. */
export async function callOperation(
  client: NixClient,
  id: string,
  call: OperationCall,
  signal?: AbortSignal,
): Promise<unknown> {
  const entry = operationById(id);
  if (entry === undefined) throw new OperationCallError(`There is no Nix operation '${id}'.`);
  const request = operationRequest(entry, call);
  const operation = `operations.${entry.id}`;
  if (request.method === 'GET')
    return client.query(
      defineQuery({ operation, path: request.path, query: request.query, schema: z.unknown() }),
      { signal, forceRefresh: true },
    );
  return client.execute(
    defineCommand({
      operation,
      method: request.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      path: request.path,
      query: request.query,
      body: call.body,
      schema: z.unknown(),
      // The catalog does not know which cached reads a call changes, so all of them go stale.
      invalidates: [[]],
    }),
    { signal },
  );
}
