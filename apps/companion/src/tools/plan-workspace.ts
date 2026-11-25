import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createDirectCollabClient, createNixClient } from '@nix/api-client';
import {
  createCompanionBodies,
  defaultIds,
  WorkspaceToolRefusal,
  type CompanionPorts,
} from '@nix/companion';
import {
  prepareWorkspacePlanTool,
  preparedWorkspacePlanToolSchema,
  runPreparedWorkspacePlanTool,
  runWorkspacePlanDiscovery,
} from '@nix/companion/plan-tools';
import { WORKSPACE_OPERATIONS } from '@nix/structure-spec';
import type { CompanionConfig } from '../core/config.ts';
import { readBounded } from '../providers/provider-errors.ts';
import { workspaceTools } from './catalog.ts';
import { flattenToolCall, validateToolArguments } from './flatten.ts';
import { workspacePlanOutcome } from './plan-workspace-outcome.ts';
import { ownerClock } from './server-tools.ts';

const scope = z.strictObject({ rootItemId: z.uuid(), readOnly: z.boolean() });
const actor = { tenantId: z.uuid(), principalId: z.uuid(), workspaceId: z.uuid() };
const binding = z.strictObject({
  runId: z.uuid(),
  planId: z.uuid(),
  planVersion: z.int().positive(),
  reviewDigest: z.string().min(1).max(128),
  stepId: z.uuid(),
  claimId: z.uuid(),
  executionId: z.uuid(),
  frozenArgumentsHash: z.string().regex(/^[A-Fa-f0-9]{64}$/),
  jobId: z.uuid().nullish(),
  workerExecutionId: z.string().max(200).nullish(),
});
const prepare = {
  ...actor,
  token: z.string().min(1).max(16_384),
  timeZone: z.string().max(64),
  scope: scope.optional(),
  lockedRead: z.boolean(),
};
const request = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('catalog') }),
  z.strictObject({
    kind: z.literal('prepare'),
    ...prepare,
    capability: z.string().max(100),
    arguments: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    kind: z.literal('prepare_flat'),
    ...prepare,
    arguments: z.string().max(40_000),
  }),
  z.strictObject({
    kind: z.literal('discover'),
    ...prepare,
    prepared: preparedWorkspacePlanToolSchema,
  }),
  z.strictObject({
    kind: z.literal('execute'),
    ...prepare,
    prepared: preparedWorkspacePlanToolSchema,
    binding,
    buildLedger: z
      .array(
        z.strictObject({
          nodeId: z.string().max(200),
          itemId: z.uuid().nullish(),
          status: z.string().max(100).nullish(),
        }),
      )
      .max(80)
      .optional(),
  }),
  z.strictObject({ kind: z.literal('poll'), ...actor, binding }),
]);
const issueResult = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('server'),
    token: z.string().min(1).max(16_384),
    requestId: z.uuid(),
    headers: z.record(z.string(), z.string().max(4096)),
  }),
  z.strictObject({ kind: z.literal('client'), requestId: z.uuid() }),
]);
const result = z.discriminatedUnion('ready', [
  z.strictObject({ ready: z.literal(false) }),
  z.strictObject({
    ready: z.literal(true),
    status: z.int().min(100).max(599),
    headers: z.record(z.string(), z.string().max(4096)),
    body: z.string().max(1_048_576),
  }),
]);

export function workspacePlanCapabilities(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  const tools = workspaceTools();
  const names = tools.map((tool) => tool.name.slice(4)).sort();
  if (JSON.stringify(names) !== JSON.stringify([...WORKSPACE_OPERATIONS].sort()))
    throw new Error('The workspace plan operation catalog is incomplete.');
  return tools.map((tool) => ({
    name: `workspace.${tool.name.slice(4)}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

interface Execution {
  actor: string;
  binding: string;
  state: 'running' | 'waiting' | 'completed' | 'partial' | 'unknown' | 'failed';
  receipt?: string;
  lockedContent?: boolean;
  reported?: boolean;
  sourceItemIds?: string[];
  unboundedSourceProvenance?: boolean;
}

/** One trusted runner per approved execution. A lost runner is uncertain and never reconstructed. */
export function createWorkspacePlanRpc(
  config: CompanionConfig,
  fetchImpl: typeof fetch = fetch,
): (input: unknown) => Promise<unknown> {
  const executions = new Map<string, Execution>();
  const internal = async (path: string, body: unknown, signal: AbortSignal) => {
    const response = await fetchImpl(`${config.apiUrl}${path}`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Nix-Internal-Secret': config.internalSecret,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new WorkspaceToolRefusal('Core refused the active plan request.');
    }
    const value: unknown = JSON.parse(await readBounded(response, 1_100_000));
    return value;
  };
  return async (input: unknown): Promise<unknown> => {
    const decoded = request.safeParse(input);
    if (!decoded.success) return undefined;
    const action = decoded.data;
    if (action.kind === 'catalog') return { ok: true, capabilities: workspacePlanCapabilities() };
    const actorKey = `${action.tenantId}/${action.principalId}/${action.workspaceId}`;
    if (action.kind === 'poll') {
      const existing = executions.get(action.binding.executionId);
      if (existing === undefined)
        return {
          ok: false,
          state: 'unknown',
          detail: 'The execution runtime restarted. Inspect Nix before retrying.',
        };
      if (existing.actor !== actorKey || existing.binding !== JSON.stringify(action.binding))
        return undefined;
      if (['completed', 'partial', 'unknown', 'failed'].includes(existing.state))
        existing.reported = true;
      return {
        ok: true,
        state: existing.state,
        executionId: action.binding.executionId,
        ...(existing.receipt === undefined ? {} : { receipt: existing.receipt }),
        ...(existing.lockedContent === undefined ? {} : { lockedContent: existing.lockedContent }),
        ...(existing.sourceItemIds === undefined ? {} : { sourceItemIds: existing.sourceItemIds }),
        ...(existing.unboundedSourceProvenance === undefined
          ? {}
          : { unboundedSourceProvenance: existing.unboundedSourceProvenance }),
      };
    }
    const signal =
      action.kind === 'execute' && action.prepared.execution === 'client'
        ? new AbortController().signal
        : AbortSignal.timeout(60_000);
    const tokens = {
      getAccessToken: () => action.token,
      refreshAccessToken: () => Promise.resolve(null),
    };
    const portsFor = (send: typeof fetch): CompanionPorts => {
      const collab = createDirectCollabClient({ baseUrl: config.collabUrl, tokens, fetch: send });
      return {
        core: createNixClient({ baseUrl: config.apiUrl, tokens, fetch: send }),
        collab,
        bodies: createCompanionBodies(collab),
        clock: ownerClock(action.timeZone),
        ids: defaultIds(),
      };
    };
    const ports = portsFor(fetchImpl);
    try {
      if (action.kind === 'prepare' || action.kind === 'prepare_flat') {
        let flat: string;
        if (action.kind === 'prepare_flat') flat = action.arguments;
        else {
          const operation = action.capability.replace(/^workspace\./, '');
          if (!workspacePlanCapabilities().some((entry) => entry.name === action.capability))
            return undefined;
          const converted = flattenToolCall(`nix_${operation}`, action.arguments);
          if (converted.flat === undefined) throw new WorkspaceToolRefusal(converted.reason);
          flat = converted.flat;
        }
        const invalid = validateToolArguments(flat);
        if (invalid !== '') throw new WorkspaceToolRefusal(invalid);
        const prepared = await prepareWorkspacePlanTool({
          ports,
          workspaceId: action.workspaceId,
          arguments: flat,
          signal,
          lockedRead: action.lockedRead,
          ...(action.scope === undefined ? {} : { scope: action.scope }),
        });
        return { ok: true, prepared };
      }
      if (action.kind === 'discover') {
        const outcome = await runWorkspacePlanDiscovery({
          ports,
          workspaceId: action.workspaceId,
          prepared: action.prepared,
          signal,
          ...(action.scope === undefined ? {} : { scope: action.scope }),
        });
        return {
          ok: true,
          state: 'completed',
          receipt: outcome.text,
          lockedContent: outcome.lockedContent,
          sourceItemIds: outcome.sourceItemIds ?? [],
          unboundedSourceProvenance: outcome.unboundedSourceProvenance ?? false,
        };
      }
      const previous = executions.get(action.binding.executionId);
      if (previous !== undefined) {
        if (previous.actor !== actorKey || previous.binding !== JSON.stringify(action.binding))
          return undefined;
        return {
          ok: true,
          state: previous.state,
          executionId: action.binding.executionId,
          ...(previous.receipt === undefined ? {} : { receipt: previous.receipt }),
          ...(previous.lockedContent === undefined
            ? {}
            : { lockedContent: previous.lockedContent }),
        };
      }
      for (const [id, saved] of executions)
        if (saved.reported && ['completed', 'partial', 'unknown', 'failed'].includes(saved.state))
          executions.delete(id);
      if (executions.size >= 32)
        throw new WorkspaceToolRefusal(
          'The plan runtime is full. Wait for the active work to finish.',
        );
      const hash = createHash('sha256').update(action.prepared.arguments).digest('hex');
      if (hash.toLowerCase() !== action.binding.frozenArgumentsHash.toLowerCase())
        throw new WorkspaceToolRefusal('The prepared arguments no longer match this plan.');
      const markerDirectory = join(
        config.dataDir,
        'plan-executions',
        action.tenantId,
        action.principalId,
      );
      mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
      try {
        writeFileSync(
          join(markerDirectory, `${action.binding.executionId}.json`),
          JSON.stringify({ workspaceId: action.workspaceId, binding: action.binding }),
          { mode: 0o600, flag: 'wx' },
        );
      } catch {
        return {
          ok: false,
          state: 'unknown',
          detail:
            'This execution was already started. Inspect its outcome before requesting another change.',
        };
      }
      const entry: Execution = {
        actor: actorKey,
        binding: JSON.stringify(action.binding),
        state: 'running',
      };
      executions.set(action.binding.executionId, entry);
      let childId = 0;
      const send: typeof fetch = async (url, init) => {
        const target = new URL(
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        );
        const destination =
          target.origin === new URL(config.apiUrl).origin
            ? 'core'
            : target.origin === new URL(config.collabUrl).origin
              ? 'collab'
              : undefined;
        if (destination === undefined)
          throw new WorkspaceToolRefusal('A plan request cannot leave its fixed Nix services.');
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'GET' && action.prepared.execution === 'server')
          return fetchImpl(url, { ...init, redirect: 'manual' });
        if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string')
          throw new WorkspaceToolRefusal('The plan request body could not be bound exactly.');
        const headers = new Headers(init?.headers);
        headers.delete('authorization');
        headers.set('X-Nix-Pet-Item-Revisions', action.prepared.revisions);
        const issued = issueResult.parse(
          await internal(
            '/internal/pet-plans/requests/issue',
            {
              tenantId: action.tenantId,
              principalId: action.principalId,
              workspaceId: action.workspaceId,
              binding: action.binding,
              childId: ++childId,
              destination,
              method,
              target: target.pathname + target.search,
              body: init?.body ?? null,
              headers: Object.fromEntries(headers),
              executor: action.prepared.execution,
            },
            signal,
          ),
        );
        if (issued.kind === 'server') {
          for (const [name, value] of Object.entries(issued.headers)) headers.set(name, value);
          headers.set('Authorization', `Bearer ${issued.token}`);
          headers.set('X-Nix-Pet-Plan-Request', issued.requestId);
          return fetchImpl(url, { ...init, headers, redirect: 'manual' });
        }
        entry.state = 'waiting';
        for (;;) {
          signal.throwIfAborted();
          const answer = result.parse(
            await internal(
              `/internal/pet-plans/requests/${issued.requestId}/result`,
              {
                tenantId: action.tenantId,
                principalId: action.principalId,
                workspaceId: action.workspaceId,
                binding: action.binding,
              },
              signal,
            ),
          );
          if (answer.ready) {
            entry.state = 'running';
            return new Response([204, 205, 304].includes(answer.status) ? null : answer.body, {
              status: answer.status,
              headers: answer.headers,
            });
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
        }
      };
      const completeClient = async (
        success: boolean,
        receipt: string,
        lockedContent: boolean,
        unknown: boolean,
      ) => {
        if (action.prepared.execution !== 'client') return;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await internal(
              '/internal/pet-plans/executions/complete',
              {
                tenantId: action.tenantId,
                principalId: action.principalId,
                workspaceId: action.workspaceId,
                binding: action.binding,
                success,
                receipt,
                lockedContent,
                unknown,
                status: entry.state,
              },
              AbortSignal.timeout(10_000),
            );
            entry.reported = true;
            return;
          } catch {
            if (attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
        }
      };
      void runPreparedWorkspacePlanTool({
        ports,
        workspaceId: action.workspaceId,
        prepared: action.prepared,
        signal,
        executionContext: {
          runId: action.binding.runId,
          planId: action.binding.planId,
          planVersion: action.binding.planVersion,
          reviewDigest: action.binding.reviewDigest,
          stepId: action.binding.stepId,
          claimId: action.binding.claimId,
          executionId: action.binding.executionId,
          dispatchContext: action.binding.executionId,
        },
        dispatch: () => Promise.resolve(portsFor(send)),
        ...(action.scope === undefined ? {} : { scope: action.scope }),
        ...(action.buildLedger === undefined
          ? {}
          : {
              buildLedger: action.buildLedger.map((entry) => ({
                nodeId: entry.nodeId,
                ...(entry.itemId == null ? {} : { itemId: entry.itemId }),
                ...(entry.status == null ? {} : { status: entry.status }),
              })),
            }),
      }).then(
        (outcome) => {
          entry.state = workspacePlanOutcome(action.prepared.operation, outcome.text);
          entry.receipt = outcome.text;
          entry.lockedContent = outcome.lockedContent;
          if (outcome.sourceItemIds !== undefined) entry.sourceItemIds = outcome.sourceItemIds;
          if (outcome.unboundedSourceProvenance !== undefined)
            entry.unboundedSourceProvenance = outcome.unboundedSourceProvenance;
          void completeClient(
            entry.state === 'completed',
            outcome.text,
            outcome.lockedContent,
            entry.state === 'unknown',
          );
        },
        () => {
          entry.state = 'failed';
          entry.receipt =
            'The operation failed or its result is uncertain. Inspect Nix before retrying a write.';
          void completeClient(false, entry.receipt, false, true);
        },
      );
      return { ok: true, state: entry.state, executionId: action.binding.executionId };
    } catch (error) {
      return {
        ok: false,
        state: 'refused',
        detail:
          error instanceof WorkspaceToolRefusal
            ? error.message
            : 'The workspace plan could not be prepared safely.',
      };
    }
  };
}
