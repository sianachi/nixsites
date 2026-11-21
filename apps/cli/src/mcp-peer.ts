import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FetchImpl } from './session.ts';

const peerUuid = z.uuid();
const credential = /^nixpeer_[A-Za-z0-9_-]{16,2040}$/;
export const peerBearer = new RegExp(`^Bearer (${credential.source.slice(1, -1)})$`, 'i');
export const peerMode = z.object({ kind: z.enum(['client', 'claude', 'codex', 'execution']) });
export const peerClaim = z.object({
  work: z
    .object({
      workId: peerUuid,
      leaseId: peerUuid,
      credential: z.string().regex(credential),
      leaseExpiresAt: z.iso.datetime({ offset: true }),
      runtime: z.enum(['claude', 'codex']),
    })
    .nullable(),
});
const peerText = (max: number) => z.string().trim().min(1).max(max);

export class PetPeerRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 401
        ? 'A live credential for this pet registration is required.'
        : status === 403
          ? 'This peer operation is unavailable for this task.'
          : status === 409
            ? 'The peer job or its lease has changed.'
            : 'The Core peer operation failed.',
    );
    this.status = status;
  }
}

export function peerIdAt(path: string): string | undefined {
  const parsed = peerUuid.safeParse(/^\/mcp\/pets\/([^/]+)$/.exec(path)?.[1]);
  return parsed.success ? parsed.data.toLowerCase() : undefined;
}

export function createPetPeerApi(
  options: { apiUrl: string; fetchImpl?: FetchImpl | undefined },
  petId: string,
  bearer: string,
) {
  const url = new URL(`/public/v1/pet-mcp/${petId}/dispatch`, options.apiUrl).toString();
  return async (body: { operation: string } & Record<string, unknown>): Promise<unknown> => {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      if (response.body) await response.body.cancel();
      throw new PetPeerRequestError(response.status);
    }
    return response.json();
  };
}

type PetPeerApi = ReturnType<typeof createPetPeerApi>;

export function createPetMcpServer(
  kind: z.infer<typeof peerMode>['kind'],
  dispatch: PetPeerApi,
): McpServer {
  const server = new McpServer({ name: 'nix-pet', version: '1.0.0' });
  registerPetPeerTools(server, kind, dispatch);
  return server;
}

function registerPetPeerTools(
  server: McpServer,
  kind: z.infer<typeof peerMode>['kind'],
  dispatch: PetPeerApi,
): void {
  const call = async (operation: string, args: Record<string, unknown> = {}) => {
    try {
      const result = await dispatch({ ...args, operation });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              error instanceof PetPeerRequestError
                ? error.message
                : 'The Core peer operation failed.',
          },
        ],
      };
    }
  };

  if (kind === 'execution') {
    server.registerTool(
      'pet_job_assignment',
      {
        description: 'Read the one approved brief assigned to this fresh runner session.',
        inputSchema: z.strictObject({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      () => call('assignment'),
    );
    return;
  }
  if (kind !== 'client') {
    server.registerTool(
      'pet_peer_claim',
      {
        description: 'Claim one approved assignment for this registered runner.',
        inputSchema: z.strictObject({}),
      },
      () => call('claim'),
    );
    server.registerTool(
      'pet_peer_finish',
      {
        description: 'Return a result using this runner’s live lease for the assigned job.',
        inputSchema: z.strictObject({
          workId: peerUuid,
          leaseId: peerUuid,
          succeeded: z.boolean(),
          result: peerText(16_000).optional(),
        }),
      },
      (args) => call('finish', args),
    );
    return;
  }

  server.registerTool(
    'pet_run_submit',
    {
      description:
        'Submit a bounded job brief to this pet for the one authorized Nix task. Use the same request ID to retry.',
      inputSchema: z.strictObject({ requestId: peerUuid, brief: peerText(3200) }),
    },
    (args) => call('submit', args),
  );
  server.registerTool(
    'pet_run_status',
    {
      description: 'Check the status of a run submitted by this registration.',
      inputSchema: z.strictObject({ runId: peerUuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => call('status', args),
  );
  server.registerTool(
    'pet_run_result',
    {
      description: 'Read the exact result the owner approved for this submitting peer.',
      inputSchema: z.strictObject({ runId: peerUuid }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => call('result', args),
  );
  server.registerTool(
    'pet_run_cancel',
    {
      description: 'Cancel a run submitted by this registration.',
      inputSchema: z.strictObject({ runId: peerUuid }),
    },
    (args) => call('cancel', args),
  );
}
