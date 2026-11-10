import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';

/**
 * Everything a session knows about who it serves, established once and re-checked on a
 * timer rather than per message.
 */
export interface SessionAuthorization extends ItemAuthorization {
  /** The token's subject, for logs that must name who was refused. */
  readonly subject: string;

  /**
   * When the credential behind this authorization stops being valid, in epoch
   * milliseconds, or null when the token does not say.
   */
  readonly tokenExpiresAt: number | null;

  /** The hidden envelope a template source resolves to; absent for ordinary item sessions. */
  readonly resolvedItemId?: string | undefined;

  /** Internal generation proving this draft authorization predates no operation fence. */
  readonly draftOperationGeneration?: number | undefined;
}

/**
 * How a session establishment can end.
 *
 * The two refusals stay distinguishable because the client's correct reactions differ: an
 * unauthenticated caller should acquire a fresh token and try again, while a refused one
 * should stop asking. What is *not* distinguishable is why authorization was refused -
 * "does not exist" and "not yours" remain the same answer.
 */
export type SessionResult =
  | { readonly ok: true; readonly value: SessionAuthorization }
  | {
      readonly ok: false;
      /**
       * `unavailable` is a refusal too - nothing is granted on it - but one that says Core could
       * not be asked, so the client retries rather than concluding its access is gone.
       */
      readonly reason:
        'unauthenticated' | 'refused' | 'locked' | 'workspace_locked' | 'unavailable';
    };

export interface SessionAuthenticator {
  /**
   * Authenticates the token and authorizes it against the item, through the cache. `fresh` skips
   * the cached answer so a lock or access change lands on the next call (it still refills the cache).
   */
  authenticate(token: string, itemId: string, fresh?: boolean): Promise<SessionResult>;

  /** Rechecks the synchronous operation fence immediately before a document room is joined. */
  isCurrent(itemId: string, authorization: SessionAuthorization): boolean;

  /** Drops expired entries. Called on a timer by the server, like the rate window. */
  sweep(): void;

  /** Fences cached, new and already-running authorization for one draft operation. */
  blockDraftOperation(operationId: string): void;

  /** Retires a successful operation's fence after every older cached answer must be dead. */
  completeDraftOperation(operationId: string): void;

  /** Releases a fence only after the caller proved Core did not activate the draft. */
  releaseDraftOperation(operationId: string): void;

  /** How many answers are cached, for the metrics gauge. */
  readonly size: number;
}

/**
 * The transport-neutral half of the handshake: token in, authorization out.
 *
 * Both the HTTP endpoints and the WebSocket handshake come through here, so there is one
 * cache and one behaviour. The cache is what makes a session affordable - without it every
 * re-check and every HTTP request costs a Core round trip - and its bound is the token's
 * own lifetime: **a cached "yes" must never outlive the credential it answered for.** A
 * revocation therefore reaches a live session within the re-check interval plus the cache
 * age, both of which are configuration, and neither of which is "when the token expires".
 */
export function createSessionAuthenticator(options: {
  tokens: TokenValidator;
  authorizer: Authorizer;
  templateItems?:
    | {
        authorize(
          token: string,
          templateId: string,
          sourceId: string,
        ): Promise<{
          itemId: string;
          tenantId: string;
          principalId: string;
          workspaceId: string;
          itemType: string;
          canRead: boolean;
          canWrite: boolean;
        }>;
      }
    | undefined;
  draftItems?:
    | {
        authorize(
          token: string,
          templateId: string,
          operationId: string,
          sourceId: string,
        ): Promise<{
          itemId: string;
          tenantId: string;
          principalId: string;
          workspaceId: string;
          itemType: string;
          canRead: boolean;
          canWrite: boolean;
        }>;
      }
    | undefined;
  /** How long a cached answer may be believed. Defaults to thirty seconds. */
  cacheTtlMs?: number;
  now?: () => number;
}): SessionAuthenticator {
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: SessionAuthorization; expiresAt: number }>();
  const blockedDrafts = new Map<string, { expiresAt: number | null }>();
  const draftAttempts = new Map<string, Set<{ cancelled: boolean }>>();
  const draftGenerations = new Map<string, number>();
  let nextDraftGeneration = 1;

  function generationFor(operationId: string): number {
    const current = draftGenerations.get(operationId);
    if (current !== undefined) return current;
    const created = nextDraftGeneration;
    nextDraftGeneration += 1;
    draftGenerations.set(operationId, created);
    return created;
  }

  return {
    async authenticate(token: string, itemId: string, fresh = false): Promise<SessionResult> {
      const template = templateIdentity(itemId);
      const draft = draftIdentity(itemId);
      const operationId = draft?.operationId.toLowerCase();
      if (operationId !== undefined && blockedDrafts.has(operationId)) {
        return { ok: false, reason: 'refused' };
      }
      const key = `${itemId}\n${token}`;
      const cached = cache.get(key);
      if (!fresh && cached !== undefined && cached.expiresAt > now()) {
        return { ok: true, value: cached.value };
      }
      cache.delete(key);

      const attempt = operationId === undefined ? null : { cancelled: false };
      if (operationId !== undefined && attempt !== null) {
        const attempts = draftAttempts.get(operationId) ?? new Set();
        attempts.add(attempt);
        draftAttempts.set(operationId, attempts);
      }
      try {
        const validated = await options.tokens.validate(token);
        if (validated === null) {
          // Refused before Core is asked anything: a token that does not validate must not
          // cost a round trip, and must not learn whether the item exists.
          return { ok: false, reason: 'unauthenticated' };
        }
        // Only after the token validates: an entry per unauthenticated draft URL would grow this
        // map from public input. A block that lands from here on still cancels the attempt above.
        const draftGeneration = operationId === undefined ? undefined : generationFor(operationId);

        let authorization:
          | (ItemAuthorization & { resolvedItemId?: string })
          | 'locked'
          | 'workspace_locked'
          | 'unavailable'
          | null;
        if (draft !== null && options.draftItems !== undefined) {
          const answer = await options.draftItems
            .authorize(token, draft.templateId, draft.operationId, draft.sourceId)
            .catch(refusalFor);
          authorization =
            answer === 'unavailable'
              ? answer
              : !answer?.canRead
                ? null
                : {
                    tenantId: answer.tenantId,
                    principalId: answer.principalId,
                    workspaceId: answer.workspaceId,
                    canWrite: answer.canWrite,
                    bodyKind: answer.itemType,
                    resolvedItemId: answer.itemId,
                  };
        } else if (template !== null && options.templateItems !== undefined) {
          const answer = await options.templateItems
            .authorize(token, template.templateId, template.sourceId)
            .catch(refusalFor);
          authorization =
            answer === 'unavailable'
              ? answer
              : !answer?.canRead
                ? null
                : {
                    tenantId: answer.tenantId,
                    principalId: answer.principalId,
                    workspaceId: answer.workspaceId,
                    // Active template revisions are immutable. User edits belong to a provisioning draft
                    // and become visible only when Core atomically swaps that draft on Save.
                    canWrite: false,
                    bodyKind: answer.itemType,
                    resolvedItemId: answer.itemId,
                  };
        } else {
          authorization = await options.authorizer.authorize(token, itemId);
        }
        if (authorization === 'locked') {
          // Never cached: an unlock must take effect on the next attempt, not after the TTL.
          return { ok: false, reason: 'locked' };
        }
        if (authorization === 'workspace_locked') {
          // A pause, not a refusal, and never cached: an unlock must take effect on the next attempt.
          return { ok: false, reason: 'workspace_locked' };
        }
        if (authorization === 'unavailable') {
          // Never cached either: the next attempt should ask Core again, not remember an outage.
          return { ok: false, reason: 'unavailable' };
        }
        if (
          authorization === null ||
          (operationId !== undefined &&
            (attempt?.cancelled === true || blockedDrafts.has(operationId)))
        ) {
          return { ok: false, reason: 'refused' };
        }

        const value: SessionAuthorization = {
          ...authorization,
          subject: validated.subject,
          tokenExpiresAt: validated.expiresAt,
          ...(draftGeneration === undefined ? {} : { draftOperationGeneration: draftGeneration }),
        };

        const expiresAt =
          validated.expiresAt === null
            ? now() + cacheTtlMs
            : Math.min(now() + cacheTtlMs, validated.expiresAt);
        if (expiresAt > now()) {
          cache.set(key, { value, expiresAt });
        }

        return { ok: true, value };
      } finally {
        if (operationId !== undefined && attempt !== null) {
          const attempts = draftAttempts.get(operationId);
          attempts?.delete(attempt);
          if (attempts?.size === 0) draftAttempts.delete(operationId);
        }
      }
    },

    isCurrent(itemId, authorization): boolean {
      const operationId = draftIdentity(itemId)?.operationId.toLowerCase();
      if (operationId === undefined) return true;
      return (
        !blockedDrafts.has(operationId) &&
        authorization.draftOperationGeneration !== undefined &&
        draftGenerations.get(operationId) === authorization.draftOperationGeneration
      );
    },

    sweep(): void {
      const at = now();
      for (const [key, entry] of cache) {
        if (entry.expiresAt <= at) {
          cache.delete(key);
        }
      }
      for (const [operationId, block] of blockedDrafts) {
        if (block.expiresAt !== null && block.expiresAt <= at && !draftAttempts.has(operationId)) {
          blockedDrafts.delete(operationId);
          draftGenerations.delete(operationId);
        }
      }
    },

    blockDraftOperation(operationId: string): void {
      const normalized = operationId.toLowerCase();
      draftGenerations.set(normalized, nextDraftGeneration);
      nextDraftGeneration += 1;
      // A pending fence has no clock-based expiry: Save may legitimately take longer than the
      // authorization cache TTL, and reopening the operation mid-save would restore write access.
      blockedDrafts.set(normalized, { expiresAt: null });
      for (const attempt of draftAttempts.get(normalized) ?? []) attempt.cancelled = true;
      for (const key of cache.keys()) {
        const authorizationKey = key.slice(0, key.indexOf('\n'));
        if (draftIdentity(authorizationKey)?.operationId.toLowerCase() === normalized) {
          cache.delete(key);
        }
      }
    },

    completeDraftOperation(operationId: string): void {
      const normalized = operationId.toLowerCase();
      if (blockedDrafts.has(normalized)) {
        // Keep the tombstone for one full cache lifetime after Core's successful transition. This
        // also covers an authorize request that was already beyond the local cancellation point.
        blockedDrafts.set(normalized, { expiresAt: now() + cacheTtlMs });
      }
    },

    releaseDraftOperation(operationId: string): void {
      blockedDrafts.delete(operationId.toLowerCase());
    },

    get size(): number {
      return cache.size;
    },
  };
}

/**
 * How a failed template or draft authorization reads: a refusal Core gave (a status below 500)
 * stays a refusal; Core failing, or not being reached at all, is `'unavailable'`.
 */
function refusalFor(cause: unknown): 'unavailable' | null {
  const status =
    typeof cause === 'object' && cause !== null && 'status' in cause ? cause.status : undefined;
  return typeof status === 'number' && status < 500 && status !== 429 ? null : 'unavailable';
}

const TEMPLATE_KEY =
  /^template:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const DRAFT_KEY =
  /^draft:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function templateIdentity(key: string): { templateId: string; sourceId: string } | null {
  const match = TEMPLATE_KEY.exec(key);
  const templateId = match?.[1];
  const sourceId = match?.[2];
  return templateId === undefined || sourceId === undefined ? null : { templateId, sourceId };
}

function draftIdentity(
  key: string,
): { templateId: string; operationId: string; sourceId: string } | null {
  const match = DRAFT_KEY.exec(key);
  const templateId = match?.[1];
  const operationId = match?.[2];
  const sourceId = match?.[3];
  return templateId === undefined || operationId === undefined || sourceId === undefined
    ? null
    : { templateId, operationId, sourceId };
}
