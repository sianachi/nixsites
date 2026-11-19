import { z } from 'zod';

const petJobTarget = z.object({
  runId: z.uuid(),
  decisionId: z.uuid().optional(),
});

export type PetJobTarget = z.infer<typeof petJobTarget>;

export function petJobHref(
  workspaceId: string,
  itemId: string,
  runId: string,
  decisionId?: string,
): string {
  const search = new URLSearchParams({ item: itemId, petRun: runId });
  if (decisionId !== undefined) search.set('petDecision', decisionId);
  return `/w/${encodeURIComponent(workspaceId)}?${search}`;
}

export function readPetJobRoute(search: URLSearchParams, itemId: string): PetJobTarget | null {
  if (search.get('item') !== itemId) return null;
  const target = petJobTarget.safeParse({
    runId: search.get('petRun'),
    decisionId: search.get('petDecision') ?? undefined,
  });
  return target.success ? target.data : null;
}

export function dismissPetJobRoute(search: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(search);
  next.delete('petRun');
  next.delete('petDecision');
  return next;
}
