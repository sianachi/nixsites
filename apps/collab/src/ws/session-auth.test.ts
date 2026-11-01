import { describe, expect, it } from 'vitest';

import type { Authorizer, ItemAuthorization } from '../auth/authorize.ts';
import type { TokenValidator } from '../auth/token.ts';
import { createSessionAuthenticator } from './session-auth.ts';

/**
 * The cache that makes a session affordable, and the bound that keeps it honest: a cached
 * "yes" must never outlive the credential it answered for.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';
const TEMPLATE = 'c1000000-0000-4000-8000-000000000041';
const SOURCE = 'c1000000-0000-4000-8000-000000000042';
const OPERATION = 'c1000000-0000-4000-8000-000000000043';

const GRANTED: ItemAuthorization = {
  tenantId: 'c1000000-0000-4000-8000-000000000001',
  principalId: 'c1000000-0000-4000-8000-000000000021',
  workspaceId: 'c1000000-0000-4000-8000-000000000011',
  canWrite: true,
  bodyKind: 'note',
};

function counting(overrides?: { expiresAt?: number | null; authorize?: Authorizer['authorize'] }): {
  tokens: TokenValidator;
  authorizer: Authorizer;
  calls: { validated: number; authorized: number };
} {
  const calls = { validated: 0, authorized: 0 };
  return {
    calls,
    tokens: {
      validate: () => {
        calls.validated += 1;
        return Promise.resolve({ subject: 'someone', expiresAt: overrides?.expiresAt ?? null });
      },
    },
    authorizer: {
      authorize:
        overrides?.authorize ??
        (() => {
          calls.authorized += 1;
          return Promise.resolve(GRANTED);
        }),
    },
  };
}

describe('session authentication', () => {
  it('reports a locked body as locked, and asks again next time so an unlock takes effect at once', async () => {
    let locked = true;
    let asked = 0;
    const { tokens, authorizer } = counting({
      authorize: () => {
        asked += 1;
        return Promise.resolve(locked ? 'locked' : GRANTED);
      },
    });
    const sessions = createSessionAuthenticator({ tokens, authorizer, cacheTtlMs: 30_000 });

    const refused = await sessions.authenticate('token', ITEM);
    expect(refused).toEqual({ ok: false, reason: 'locked' });

    locked = false;
    const opened = await sessions.authenticate('token', ITEM);
    expect(opened.ok).toBe(true);
    expect(asked).toBe(2);
  });

  it('answers from the cache within its lifetime, so a session does not cost a round trip per ask', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting();
    const sessions = createSessionAuthenticator({
      tokens,
      authorizer,
      cacheTtlMs: 500,
      now: () => at,
    });

    await sessions.authenticate('token', ITEM);
    at += 400;
    const second = await sessions.authenticate('token', ITEM);

    expect(second.ok).toBe(true);
    expect(calls.authorized).toBe(1);
  });

  it('asks Core again when the caller wants a fresh answer, whatever the cache holds', async () => {
    const { tokens, authorizer, calls } = counting();
    const sessions = createSessionAuthenticator({ tokens, authorizer, cacheTtlMs: 30_000 });

    await sessions.authenticate('token', ITEM);
    await sessions.authenticate('token', ITEM, true);

    expect(calls.authorized).toBe(2);
  });

  it('asks again once the cache entry has aged out', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting();
    const sessions = createSessionAuthenticator({
      tokens,
      authorizer,
      cacheTtlMs: 500,
      now: () => at,
    });

    await sessions.authenticate('token', ITEM);
    at += 501;
    await sessions.authenticate('token', ITEM);

    expect(calls.authorized).toBe(2);
  });

  it('never believes a cached answer past the token expiry, whatever the cache lifetime says', async () => {
    let at = 1_000;
    const { tokens, authorizer, calls } = counting({ expiresAt: 1_200 });
    const sessions = createSessionAuthenticator({
      tokens,
      authorizer,
      cacheTtlMs: 60_000,
      now: () => at,
    });

    await sessions.authenticate('token', ITEM);
    at = 1_201;
    await sessions.authenticate('token', ITEM);

    // The second ask went back to the source: an hour-long cache must not stretch a
    // two-hundred-millisecond credential.
    expect(calls.validated).toBe(2);
    expect(calls.authorized).toBe(2);
  });

  it('distinguishes a bad token from a refused item, because the client reactions differ', async () => {
    const refused = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(null) },
    });
    const unauthenticated = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve(null) },
      authorizer: { authorize: () => Promise.resolve(GRANTED) },
    });

    expect(await refused.authenticate('token', ITEM)).toEqual({ ok: false, reason: 'refused' });
    expect(await unauthenticated.authenticate('token', ITEM)).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
  });

  it('never asks Core when the token does not validate', async () => {
    let asked = 0;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve(null) },
      authorizer: {
        authorize: () => {
          asked += 1;
          return Promise.resolve(null);
        },
      },
    });

    await sessions.authenticate('forged', ITEM);

    expect(asked).toBe(0);
  });

  it('does not cache refusals, so a permission granted mid-session is seen at the next ask', async () => {
    let allowed = false;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(allowed ? GRANTED : null) },
    });

    const before = await sessions.authenticate('token', ITEM);
    allowed = true;
    const after = await sessions.authenticate('token', ITEM);

    expect(before.ok).toBe(false);
    expect(after.ok).toBe(true);
  });

  it('sweeps expired entries so the cache is a cache and not a leak', async () => {
    let at = 1_000;
    const { tokens, authorizer } = counting();
    const sessions = createSessionAuthenticator({
      tokens,
      authorizer,
      cacheTtlMs: 500,
      now: () => at,
    });

    await sessions.authenticate('token-one', ITEM);
    await sessions.authenticate('token-two', ITEM);
    expect(sessions.size).toBe(2);

    at += 501;
    sessions.sweep();

    expect(sessions.size).toBe(0);
  });

  it('resolves an active template source read-only so edits cannot bypass a staged draft', async () => {
    const hiddenItem = 'c1000000-0000-4000-8000-000000000099';
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.reject(new Error('Ordinary auth must not run.')) },
      templateItems: {
        authorize: () =>
          Promise.resolve({
            itemId: hiddenItem,
            tenantId: GRANTED.tenantId,
            principalId: GRANTED.principalId,
            workspaceId: GRANTED.workspaceId,
            itemType: 'note',
            canRead: true,
            canWrite: true,
          }),
      },
    });

    const answer = await sessions.authenticate('token', `template:${TEMPLATE}:${SOURCE}`);

    expect(answer).toMatchObject({
      ok: true,
      value: { resolvedItemId: hiddenItem, bodyKind: 'note', canWrite: false },
    });
  });

  it('resolves a portable draft source to its provisioning document', async () => {
    const hiddenItem = 'c1000000-0000-4000-8000-000000000098';
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.reject(new Error('Ordinary auth must not run.')) },
      draftItems: {
        authorize: () =>
          Promise.resolve({
            itemId: hiddenItem,
            tenantId: GRANTED.tenantId,
            principalId: GRANTED.principalId,
            workspaceId: GRANTED.workspaceId,
            itemType: 'note',
            canRead: true,
            canWrite: true,
          }),
      },
    });

    const answer = await sessions.authenticate('token', `draft:${TEMPLATE}:${OPERATION}:${SOURCE}`);

    expect(answer).toMatchObject({
      ok: true,
      value: { resolvedItemId: hiddenItem, bodyKind: 'note', canWrite: true },
    });
  });

  it('blocks only cached answers belonging to the saved draft operation', async () => {
    let authorizations = 0;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(GRANTED) },
      draftItems: {
        authorize: () => {
          authorizations += 1;
          return Promise.resolve({
            itemId: ITEM,
            tenantId: GRANTED.tenantId,
            principalId: GRANTED.principalId,
            workspaceId: GRANTED.workspaceId,
            itemType: 'note',
            canRead: true,
            canWrite: true,
          });
        },
      },
    });
    const otherOperation = 'c1000000-0000-4000-8000-000000000044';
    const savedKey = `draft:${TEMPLATE}:${OPERATION}:${SOURCE}`;
    const otherKey = `draft:${TEMPLATE}:${otherOperation}:${SOURCE}`;

    const stale = await sessions.authenticate('token', savedKey);
    await sessions.authenticate('token', otherKey);
    sessions.blockDraftOperation(OPERATION);
    if (!stale.ok) throw new Error('The draft authorization fixture was refused.');
    expect(sessions.isCurrent(savedKey, stale.value)).toBe(false);
    await expect(sessions.authenticate('token', savedKey)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    await sessions.authenticate('token', otherKey);

    expect(authorizations).toBe(2);

    sessions.releaseDraftOperation(OPERATION);
    expect(sessions.isCurrent(savedKey, stale.value)).toBe(false);
    await sessions.authenticate('token', savedKey);
    expect(authorizations).toBe(3);
  });

  it('refuses an authorize result that returns after the draft operation was blocked', async () => {
    let authorizeCalls = 0;
    let enterAuthorize: (() => void) | undefined;
    const enteredAuthorize = new Promise<void>((resolve) => {
      enterAuthorize = resolve;
    });
    let finishAuthorize: (() => void) | undefined;
    const authorizationReleased = new Promise<void>((resolve) => {
      finishAuthorize = resolve;
    });
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(GRANTED) },
      draftItems: {
        authorize: async () => {
          authorizeCalls += 1;
          enterAuthorize?.();
          await authorizationReleased;
          return {
            itemId: ITEM,
            tenantId: GRANTED.tenantId,
            principalId: GRANTED.principalId,
            workspaceId: GRANTED.workspaceId,
            itemType: 'note',
            canRead: true,
            canWrite: true,
          };
        },
      },
    });
    const savedKey = `draft:${TEMPLATE}:${OPERATION}:${SOURCE}`;

    const staleAuthorization = sessions.authenticate('token', savedKey);
    await enteredAuthorize;
    sessions.blockDraftOperation(OPERATION);

    await expect(sessions.authenticate('token', savedKey)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(authorizeCalls).toBe(1);

    finishAuthorize?.();
    await expect(staleAuthorization).resolves.toEqual({ ok: false, reason: 'refused' });
    expect(sessions.size).toBe(0);

    sessions.releaseDraftOperation(OPERATION);
    await expect(sessions.authenticate('token', savedKey)).resolves.toMatchObject({ ok: true });
    expect(authorizeCalls).toBe(2);
  });

  it('does not expire a pending operation fence before Save completes', async () => {
    let clock = 0;
    let authorizations = 0;
    const sessions = createSessionAuthenticator({
      tokens: { validate: () => Promise.resolve({ subject: 's', expiresAt: null }) },
      authorizer: { authorize: () => Promise.resolve(GRANTED) },
      draftItems: {
        authorize: () => {
          authorizations += 1;
          return Promise.resolve({
            itemId: ITEM,
            tenantId: GRANTED.tenantId,
            principalId: GRANTED.principalId,
            workspaceId: GRANTED.workspaceId,
            itemType: 'note',
            canRead: true,
            canWrite: true,
          });
        },
      },
      cacheTtlMs: 10,
      now: () => clock,
    });
    const savedKey = `draft:${TEMPLATE}:${OPERATION}:${SOURCE}`;

    sessions.blockDraftOperation(OPERATION);
    clock = 100;
    sessions.sweep();
    await expect(sessions.authenticate('token', savedKey)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(authorizations).toBe(0);

    sessions.completeDraftOperation(OPERATION);
    clock = 111;
    sessions.sweep();
    await sessions.authenticate('token', savedKey);
    expect(authorizations).toBe(1);
  });
});
