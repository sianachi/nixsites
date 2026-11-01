import { describe, expect, it } from 'vitest';

import { createAuthorizer } from './authorize.ts';

/**
 * How Core's answer to "may this caller open this item" is read.
 *
 * Only one refusal is told apart: a body locked to this session. Everything else Core refuses is
 * the same non-answer, so "does not exist" and "not yours" stay indistinguishable here too.
 */

const ITEM = 'c1000000-0000-4000-8000-000000000031';

function answering(status: number, body: unknown) {
  return createAuthorizer({
    coreBaseUrl: 'http://core.test',
    internalSecret: 'secret',
    fetch: () => Promise.resolve(Response.json(body, { status })),
  });
}

describe('the Core authorizer', () => {
  it('reads a locked body as locked', async () => {
    const authorizer = answering(403, { code: 'internal.body_locked' });

    expect(await authorizer.authorize('token', ITEM)).toBe('locked');
  });

  it('reads any other refusal as the uniform non-answer', async () => {
    expect(
      await answering(404, { code: 'internal.not_found' }).authorize('token', ITEM),
    ).toBeNull();
    expect(await answering(403, { code: 'something.else' }).authorize('token', ITEM)).toBeNull();
    expect(await answering(403, 'not json at all').authorize('token', ITEM)).toBeNull();
  });

  it('reads Core failing, or not answering, as unavailable rather than as a refusal', async () => {
    // Still not a yes. But a refusal tells a client its access is gone, and a client acting on
    // that discards its cached body and its unsaved drafts - an outage must not cost anyone that.
    expect(await answering(503, {}).authorize('token', ITEM)).toBe('unavailable');
    expect(await answering(500, {}).authorize('token', ITEM)).toBe('unavailable');
    expect(await answering(429, {}).authorize('token', ITEM)).toBe('unavailable');

    const unreachable = createAuthorizer({
      coreBaseUrl: 'http://core.test',
      internalSecret: 'secret',
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await unreachable.authorize('token', ITEM)).toBe('unavailable');
  });

  it('tells Core which release it runs', async () => {
    let sent: Headers | undefined;
    const authorizer = createAuthorizer({
      coreBaseUrl: 'http://core.test',
      internalSecret: 'secret',
      release: { version: '0.5.0', commit: 'abc123' },
      fetch: (_url, init) => {
        sent = new Headers(init?.headers);
        return Promise.resolve(Response.json({}, { status: 404 }));
      },
    });

    await authorizer.authorize('token', ITEM);

    expect(sent?.get('x-nix-service')).toBe('collab');
    expect(sent?.get('x-nix-release-version')).toBe('0.5.0');
    expect(sent?.get('x-nix-release-commit')).toBe('abc123');
  });
});
