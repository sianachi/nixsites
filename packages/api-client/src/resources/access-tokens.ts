/**
 * The personal-access-token resource: the only place its URLs appear.
 *
 * Management (list, mint, rotate, revoke) hangs under `/me` and requires an interactive session - the API
 * refuses a token-authenticated caller here, so these descriptors are for the settings
 * screen, never for a scripted client. The exchange is the opposite: unauthenticated by nature,
 * because a session is what it buys.
 */

import {
  defineCommand,
  defineQuery,
  type CommandEndpoint,
  type QueryEndpoint,
} from '../endpoints.js';
import {
  accessTokenListSchema,
  createdAccessTokenSchema,
  noContentSchema,
  tokenExchangeResponseSchema,
  type AccessTokenList,
  type CreatedAccessToken,
  type TokenExchangeResponse,
} from '../schemas/index.js';

/** Cache key for the caller's token list. */
const tokensKey: readonly string[] = ['me', 'tokens'];

/** The caller's tokens, newest first, revoked and expired included - the list is an audit. */
export const listAccessTokens = (): QueryEndpoint<AccessTokenList> =>
  defineQuery<AccessTokenList>({
    operation: 'tokens.list',
    path: '/api/v1/me/tokens',
    schema: accessTokenListSchema,
    cacheKey: tokensKey,
  });

export interface CreateAccessTokenInput {
  /** What the token is for, so the list reads as intentions. */
  readonly name: string;
  /** At least one of `read`, `write`, `admin`. Independent - `write` does not imply `read`. */
  readonly scopes: readonly string[];
  /** How long it lives, 1 to 365 days. Required: expiry is chosen, never defaulted. */
  readonly expiresInDays: number;
}

/**
 * Mints a token. The response is the only place the secret ever appears; render it once and let
 * it go - there is no second read. Fails with `tokens.invalid` and `tokens.limit_reached`.
 */
export const createAccessToken = (
  input: CreateAccessTokenInput,
): CommandEndpoint<CreatedAccessToken> =>
  defineCommand<CreatedAccessToken>({
    operation: 'tokens.create',
    method: 'POST',
    path: '/api/v1/me/tokens',
    schema: createdAccessTokenSchema,
    body: {
      name: input.name,
      scopes: input.scopes,
      expiresInDays: input.expiresInDays,
    },
    invalidates: [tokensKey],
  });

/**
 * Revokes a token, effective on its very next request. Idempotent, and always 204: a token
 * already revoked, never issued, or not the caller's answers the same way on purpose.
 */
export const revokeAccessToken = (tokenId: string): CommandEndpoint<undefined> =>
  defineCommand<undefined>({
    operation: 'tokens.revoke',
    method: 'DELETE',
    path: `/api/v1/me/tokens/${tokenId}`,
    schema: noContentSchema,
    invalidates: [tokensKey],
  });

/**
 * Replaces a live token's secret, keeping its id, name and scopes. The old secret dies at once and
 * the new one appears in this response only. Fails with `tokens.not_found` and, for a revoked or
 * expired token, `tokens.not_rotatable`.
 */
export const rotateAccessToken = (tokenId: string): CommandEndpoint<CreatedAccessToken> =>
  defineCommand<CreatedAccessToken>({
    operation: 'tokens.rotate',
    method: 'POST',
    path: `/api/v1/me/tokens/${tokenId}/rotate`,
    schema: createdAccessTokenSchema,
    invalidates: [tokensKey],
  });

/**
 * Exchanges a personal access token for a short-lived JWT every Nix service accepts. Meant for
 * non-browser clients; the web application never holds a personal access token.
 */
export const exchangeAccessToken = (token: string): CommandEndpoint<TokenExchangeResponse> =>
  defineCommand<TokenExchangeResponse>({
    operation: 'tokens.exchange',
    method: 'POST',
    path: '/public/v1/auth/token',
    schema: tokenExchangeResponseSchema,
    body: { token },
  });
