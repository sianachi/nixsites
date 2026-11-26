import { petPlans, type PetPlanSharingQuestion } from '@nix/api-client';
import { z } from 'zod';

/** The sharing endpoints are independent of the legacy runtime responses these callers drive. */
interface SharingFixture {
  readonly calls: unknown[];
  reset(): void;
  requireReview(): void;
  reply(endpoint: unknown): Promise<{ question: PetPlanSharingQuestion | null }> | undefined;
}
export function petSharingFixture(): SharingFixture {
  let alreadyGranted = true;
  const grants = new Set<string>();
  const challenges = new Map<string, string>();
  const calls: unknown[] = [];
  return {
    calls,
    reset() {
      alreadyGranted = true;
      grants.clear();
      challenges.clear();
      calls.length = 0;
    },
    requireReview() {
      alreadyGranted = false;
    },
    reply(endpoint: unknown) {
      const route = z.object({ path: z.string() }).safeParse(endpoint);
      if (!route.success || !/\/pet-sharing\/(question|decision)$/u.test(route.data.path))
        return undefined;
      calls.push(endpoint);
      const { body } = z
        .object({
          body: z.object({
            petId: z.uuid(),
            sourceScope: petPlans.sourceScopeSchema,
            approve: z.boolean().optional(),
            decisionNonce: z.string().optional(),
          }),
        })
        .parse(endpoint);
      const key = JSON.stringify([body.petId, body.sourceScope]);
      if (route.data.path.endsWith('/decision')) {
        if (body.decisionNonce !== challenges.get(key))
          throw new Error('Sharing decision must use the displayed challenge');
        if (body.approve === true) grants.add(key);
        else grants.delete(key);
        challenges.delete(key);
        return Promise.resolve({ question: null });
      }
      if (alreadyGranted || grants.has(key)) return Promise.resolve({ question: null });
      let decisionNonce = challenges.get(key);
      if (decisionNonce === undefined) {
        decisionNonce = crypto.randomUUID();
        challenges.set(key, decisionNonce);
      }
      return Promise.resolve({
        question: {
          decisionNonce,
          scopeDigest: 'synthetic-scope',
          recipientRevision: 'synthetic-recipient',
          sourceScope: body.sourceScope,
          recipient: {
            provider: 'Claude',
            destination: 'https://api.anthropic.com',
            routingPolicy: 'Direct',
            connectionRevision: 'synthetic-connection',
          },
          message: 'Share these selected sources with Claude?',
        },
      });
    },
  };
}
