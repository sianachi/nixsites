import {
  automations,
  callOperation,
  findOperations,
  isHumanOnlyOperation,
  OperationCallError,
  operationById,
  operationRequest,
  operationRisk,
  type NixClient,
  type OperationCall,
  type OperationEntry,
  type OperationRisk,
  sites,
  templates,
} from '@nix/api-client';
import type { Problem } from '@nix/structure-spec';
import { z } from 'zod';
import { WorkspaceToolRefusal } from './tool-args.js';

/** Path parameters that name an item: each is checked to be in this workspace before a run. */
const ITEM_PARAMS = ['itemId', 'sourceItemId', 'containerItemId'];

export interface ActionRun {
  entry: OperationEntry;
  call: OperationCall;
  risk: OperationRisk;
  /** The items the path names, to check for workspace and lock before the run. */
  itemIds: string[];
}

/** An object the model may send natively or as JSON text. */
const objectPart = z.preprocess(
  (value): unknown => (typeof value === 'string' ? (JSON.parse(value) as unknown) : value),
  z.record(z.string(), z.unknown()).optional(),
);

const callSchema = z.object({
  path: objectPart.pipe(z.record(z.string(), z.string()).optional()),
  params: objectPart.pipe(
    z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ),
  body: objectPart,
});

/** The action a `run_action` request names and the request it would send, or a refusal the model can
 * act on. `query` carries the action id and `specJson` the path, params and body. */
export function parseActionRun(query: string, specJson: string, workspaceId: string): ActionRun {
  const entry = operationById(query.trim());
  if (entry === undefined)
    throw new WorkspaceToolRefusal(
      `There is no action '${query.trim()}'. Find one with nix_find_action.`,
    );
  if (isHumanOnlyOperation(entry))
    throw new WorkspaceToolRefusal(
      'This changes credentials or the pet’s own settings. The owner does it in Settings; nothing was run.',
      'This is something only you can do, in Settings, so nothing was run.',
    );
  let parts: z.infer<typeof callSchema>;
  try {
    parts = callSchema.parse(specJson.trim() ? JSON.parse(specJson) : {});
  } catch {
    throw new WorkspaceToolRefusal(
      'path and params must be objects of strings, and body an object. Nothing was run.',
    );
  }
  const call: OperationCall = { path: parts.path, query: parts.params, body: parts.body };
  try {
    operationRequest(entry, call);
  } catch (reason) {
    if (reason instanceof OperationCallError) throw new WorkspaceToolRefusal(reason.message);
    throw reason;
  }
  if (parts.path?.workspaceId !== undefined && parts.path.workspaceId !== workspaceId)
    throw new WorkspaceToolRefusal('That workspace is not this conversation’s. Nothing was run.');
  return {
    entry,
    call,
    risk: operationRisk(entry),
    itemIds: ITEM_PARAMS.flatMap((name) => parts.path?.[name] ?? []),
  };
}

/** Keys that name a workspace or items anywhere in the request's query or body. */
const WORKSPACE_KEY = /^(workspaceId|workspaceIds|sourceWorkspaceIds)$/;
const ITEM_KEY = /(^itemIds?$|ItemIds?$|^parentId$|^afterId$)/;

function idsUnder(value: unknown, key: RegExp, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) idsUnder(entry, key, found);
  else if (value !== null && typeof value === 'object')
    for (const [name, inner] of Object.entries(value)) {
      if (key.test(name))
        for (const id of [inner].flat()) if (typeof id === 'string' && id !== '') found.push(id);
      idsUnder(inner, key, found);
    }
  return found;
}

/**
 * Confines a run to this conversation's workspace before it is previewed or sent. Every workspace
 * named in the path, query or body must be this one. Every item named anywhere goes through the
 * same workspace and lock check as the typed tools. A site, automation or template in the path must
 * belong here too. Ids nested under those (comments, builds, finance lines) are Core's to scope.
 */
export async function confineActionRun(
  client: NixClient,
  run: ActionRun,
  workspaceId: string,
  check: (itemId: string) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const elsewhere = () =>
    new WorkspaceToolRefusal(
      'That names another workspace than this conversation’s. Nothing was run. To move an item to another workspace, use nix_move_item.',
    );
  for (const id of idsUnder([run.call.query, run.call.body], WORKSPACE_KEY))
    if (id !== workspaceId) throw elsewhere();
  for (const id of new Set([
    ...run.itemIds,
    ...idsUnder([run.call.query, run.call.body], ITEM_KEY),
  ]))
    await check(id);
  const path = run.call.path ?? {};
  const options = { signal, forceRefresh: true };
  const owners = [
    path.siteId && (await client.query(sites.getSite(path.siteId), options)).workspaceId,
    path.ruleId && (await client.query(automations.get(path.ruleId), options)).workspaceId,
    path.templateId &&
      (await client.query(templates.templateById(path.templateId), options)).workspaceId,
  ];
  if (owners.some((owner) => owner && owner !== workspaceId)) throw elsewhere();
}

export const runAction = (
  client: NixClient,
  run: ActionRun,
  signal: AbortSignal,
): Promise<unknown> => callOperation(client, run.entry.id, run.call, signal);

/** What `nix_find_action` answers: the best matches with everything needed to call one. */
export function findActions(query: string): {
  actions: (Omit<OperationEntry, 'area' | 'uuidParams'> & { risk: OperationRisk })[];
} {
  return {
    actions: findOperations(query, 8, (entry) => !isHumanOnlyOperation(entry)).map((entry) => ({
      id: entry.id,
      method: entry.method,
      path: entry.path,
      summary: entry.summary,
      detail: entry.detail,
      pathParams: entry.pathParams,
      queryParams: entry.queryParams,
      body: entry.body,
      risk: operationRisk(entry),
    })),
  };
}

const RISK_SENTENCE: Record<NonNullable<OperationRisk>, string> = {
  irreversible: 'This can’t be undone.',
  access: 'This changes who can open or change something.',
  public: 'This makes something public.',
};

/** JSON with invisible and direction-changing characters spelled out, so the card can't hide text. */
const shown = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** The card's lines for a run: the exact request, any warning, and the body in full. */
export function describeActionRun(run: ActionRun): {
  headline: string;
  notes: string[];
  warnings: Problem[];
} {
  const { entry, call } = run;
  const request = operationRequest(entry, call);
  const query = new URLSearchParams(
    Object.entries(request.query).map(([name, value]) => [name, String(value)]),
  ).toString();
  return {
    headline: `I will run “${entry.summary || entry.id}” (${entry.id}).`,
    notes: [
      `${request.method} ${shown(request.path).slice(1, -1)}${query ? `?${shown(query).slice(1, -1)}` : ''}`,
      ...(call.body === undefined ? [] : [`Body: ${shown(call.body)}`]),
    ],
    warnings:
      run.risk === undefined
        ? []
        : [{ path: 'actionId', code: `action_${run.risk}`, message: RISK_SENTENCE[run.risk] }],
  };
}
