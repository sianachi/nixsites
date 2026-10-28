/**
 * Personal access tokens: the credentials a principal issues for non-browser clients, and the
 * exchange that turns one into a short-lived session.
 *
 * The secret string appears in exactly one shape here - the create response - because that is the
 * one time the API ever shows it. Every other shape carries metadata only, which is why a token
 * list is safe to cache and render like any other server state.
 */

import { z } from 'zod';
import type { components } from '../generated/api.js';

/** The three scope spellings the API accepts, in the order the interface offers them. */
export const ACCESS_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;

export const accessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

export const accessTokenListSchema = z.object({
  tokens: z.array(accessTokenSchema),
});

export type AccessTokenList = z.infer<typeof accessTokenListSchema>;

export const createdAccessTokenSchema = z.object({
  /** The full secret, shown here and never again. */
  token: z.string(),
  details: accessTokenSchema,
});

export type CreatedAccessToken = z.infer<typeof createdAccessTokenSchema>;

export const tokenExchangeResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string(),
  expiresInSeconds: z.number(),
});

export type TokenExchangeResponse = z.infer<typeof tokenExchangeResponseSchema>;

const _accessTokenContract = accessTokenSchema satisfies z.ZodType<
  components['schemas']['AccessTokenResponse']
>;
void _accessTokenContract;

const _accessTokenListContract = accessTokenListSchema satisfies z.ZodType<
  components['schemas']['AccessTokenListResponse']
>;
void _accessTokenListContract;

const _createdAccessTokenContract = createdAccessTokenSchema satisfies z.ZodType<
  components['schemas']['CreatedAccessTokenResponse']
>;
void _createdAccessTokenContract;

const _tokenExchangeContract = tokenExchangeResponseSchema satisfies z.ZodType<
  components['schemas']['TokenExchangeResponse']
>;
void _tokenExchangeContract;
