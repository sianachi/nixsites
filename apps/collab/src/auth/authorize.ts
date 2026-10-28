/**
 * What Core says about an item the caller asked for.
 *
 * Every field is Core's answer rather than this service's guess, which is the point: there
 * is one authorization code path in the system and it is not this file.
 */
export interface ItemAuthorization {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceId: string;

  /**
   * Whether the principal may append updates to the item's body. Reading was already
   * answered by the 200 itself - an item the caller may not read is 404, never described.
   */
  readonly canWrite: boolean;

  /**
   * The item's `type` - how its own body is drawn, which validation dispatches on. An open
   * string by design (ADR-0009); an unknown kind is treated as the default prose body.
   */
  readonly bodyKind: string;

  /**
   * False when collaboration is switched off for the item or its workspace: one principal edits
   * and everyone else reads until they leave. Absent means collaborative, which is also what a
   * Core that predates the switch implies.
   */
  readonly collaborative?: boolean;
}

export interface Authorizer {
  /**
   * Whether the bearer of this token may reach this item, and in which tenant.
   *
   * Null means refused - and refused is all a caller may learn. Core reports an item the
   * caller cannot see as not found, so "does not exist" and "not yours" are the same answer
   * there and must stay the same answer here.
   *
   * `'locked'` means the caller may see the item but its body is locked to this session. Core
   * says so only after its read check, to somebody who could ask its lock route the same thing,
   * so passing it on discloses nothing - and lets a client say "unlock it" rather than "missing".
   *
   * `'unavailable'` means Core could not answer at all - unreachable, too slow, or failing on its
   * own side. It is still not a yes: every caller refuses on it. What it changes is the reason
   * given, because "you may not" makes a client discard what it holds and stop, and a Core outage
   * is no reason for anyone to lose their unsaved work.
   */
  authorize(
    token: string,
    itemId: string,
  ): Promise<ItemAuthorization | 'locked' | 'unavailable' | null>;
}

/**
 * Authorization by forwarding the caller's own token to Core's internal surface.
 *
 * **No permission logic here.** This service presents two proofs: the shared secret says
 * "the collaboration service is asking", and the forwarded user token says on whose behalf.
 * Core answers for that principal against the database, so a permission change takes effect
 * here the moment it takes effect there, and there is no second implementation of the rules
 * to drift. Compromising this process yields the internal surface but no principal - every
 * answer is still bounded by a real user's real token.
 *
 * One round trip per session establishment and per periodic re-check, not per update: the
 * caching that makes that safe lives in the session layer, bounded by the token's own
 * lifetime, never here.
 */
export function createAuthorizer(options: {
  coreBaseUrl: string;
  internalSecret: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Authorizer {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async authorize(
      token: string,
      itemId: string,
    ): Promise<ItemAuthorization | 'locked' | 'unavailable' | null> {
      let response: Response;
      try {
        response = await doFetch(`${options.coreBaseUrl}/internal/authz/items/${itemId}`, {
          headers: {
            authorization: `Bearer ${token}`,
            'x-nix-internal-secret': options.internalSecret,
            accept: 'application/json',
          },
          // Bounded, because a Core that has stopped answering must not turn into this
          // service holding connections open until it runs out of them.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return 'unavailable';
      }

      // An accepted, narrow existence signal: Core answers a missing or foreign item with a cheap
      // 404 before any further work, so a fault later in its checks can only happen for an item
      // that exists in the caller's tenant. Read as `unavailable`, a fault under load hints that
      // much to a same-tenant caller - probabilistically, never on demand, and no more than the
      // timing of those extra checks already does. The alternative, reporting Core's own failures
      // as refusals, made clients discard unsaved drafts during every outage.
      if (response.status >= 500 || response.status === 429) {
        return 'unavailable';
      }

      if (!response.ok) {
        if (response.status === 403) {
          const refusal = (await response.json().catch(() => null)) as { code?: unknown } | null;
          if (refusal?.code === 'internal.body_locked') {
            return 'locked';
          }
        }
        return null;
      }

      const answer = (await response.json().catch(() => null)) as {
        tenantId?: unknown;
        principalId?: unknown;
        workspaceId?: unknown;
        canWrite?: unknown;
        bodyKind?: unknown;
        collaborative?: unknown;
      } | null;

      if (
        answer === null ||
        typeof answer.tenantId !== 'string' ||
        typeof answer.principalId !== 'string' ||
        typeof answer.workspaceId !== 'string' ||
        typeof answer.canWrite !== 'boolean' ||
        typeof answer.bodyKind !== 'string'
      ) {
        return null;
      }

      return {
        tenantId: answer.tenantId,
        principalId: answer.principalId,
        workspaceId: answer.workspaceId,
        canWrite: answer.canWrite,
        bodyKind: answer.bodyKind,
        collaborative: answer.collaborative !== false,
      };
    },
  };
}
