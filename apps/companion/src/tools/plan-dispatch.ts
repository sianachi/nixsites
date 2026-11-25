import { z } from 'zod';
import { readBounded } from '../providers/provider-errors.ts';

export const planExecutionBindingSchema = z.strictObject({
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
export const planExecutionEnvelopeSchema = z.strictObject({
  tenantId: z.uuid(),
  principalId: z.uuid(),
  workspaceId: z.uuid(),
  binding: planExecutionBindingSchema,
  revisions: z.string().max(4000),
});
export interface PlanDispatchOptions {
  apiUrl: string;
  collabUrl: string;
  internalSecret: string;
}
const issuedSchema = z.strictObject({
  kind: z.literal('server'),
  token: z.string().min(1).max(16_384),
  requestId: z.uuid(),
  headers: z.record(z.string(), z.string().max(4096)),
});

/** Native body adapters use the same exact child permits as workspace tools. */
export function createServerPlanFetch(
  options: PlanDispatchOptions,
  envelope: z.infer<typeof planExecutionEnvelopeSchema>,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  let childId = 0;
  return async (url, init) => {
    const destinationUrl = new URL(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
    );
    const destination =
      destinationUrl.origin === new URL(options.collabUrl).origin
        ? 'collab'
        : destinationUrl.origin === new URL(options.apiUrl).origin
          ? 'core'
          : undefined;
    if (destination === undefined)
      throw new Error('The native plan request left its fixed Nix services.');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') return fetchImpl(url, { ...init, redirect: 'manual' });
    if (init?.body !== null && init?.body !== undefined && typeof init.body !== 'string')
      throw new Error('The native request body cannot be bound exactly.');
    const headers = new Headers(init?.headers);
    headers.delete('authorization');
    headers.set('X-Nix-Pet-Item-Revisions', envelope.revisions);
    const response = await fetchImpl(`${options.apiUrl}/internal/pet-plans/requests/issue`, {
      method: 'POST',
      redirect: 'manual',
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Nix-Internal-Secret': options.internalSecret,
      },
      body: JSON.stringify({
        tenantId: envelope.tenantId,
        principalId: envelope.principalId,
        workspaceId: envelope.workspaceId,
        binding: envelope.binding,
        childId: ++childId,
        destination,
        method,
        target: destinationUrl.pathname + destinationUrl.search,
        body: init?.body ?? null,
        headers: Object.fromEntries(headers),
        executor: 'server',
      }),
    });
    if (!response.ok) {
      void response.body?.cancel();
      throw new Error('Core refused the native plan dispatch.');
    }
    const issued = issuedSchema.parse(JSON.parse(await readBounded(response, 32_768)));
    for (const [name, value] of Object.entries(issued.headers)) headers.set(name, value);
    headers.set('Authorization', `Bearer ${issued.token}`);
    headers.set('X-Nix-Pet-Plan-Request', issued.requestId);
    return fetchImpl(url, { ...init, headers, redirect: 'manual' });
  };
}
