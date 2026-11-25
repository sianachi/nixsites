import { petPlans } from '@nix/api-client';
import { z } from 'zod';

const providerContextSchema = z.strictObject({
  recipientRevision: z.string().min(1).max(256),
  turnId: z.uuid(),
  sourceScope: petPlans.sourceScopeSchema,
  sourceItemIds: z.array(z.uuid()).max(128),
  protectedRead: z.boolean(),
  unbounded: z.boolean(),
});
export type ProviderContextProvenance = z.infer<typeof providerContextSchema>;
export const HISTORY_SHARING_RECOVERY =
  'Sharing consent for this history could not be confirmed. Start a new conversation; your existing messages remain available.';

export function readProviderContext(value: unknown): ProviderContextProvenance | undefined {
  const parsed = providerContextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function addContextSources(
  context: ProviderContextProvenance,
  ids: string[],
  protectedRead: boolean,
  unbounded: boolean,
): void {
  const distinct = [...new Set([...context.sourceItemIds, ...ids])];
  context.sourceItemIds = distinct.slice(0, 128);
  context.protectedRead ||= protectedRead;
  context.unbounded ||= unbounded || distinct.length > 128;
}
