/** OAuth consent for remote MCP clients. Browser-session only, like token creation. Bodies and answers are typed from Core's generated schemas, so drift fails the type check. */

import { z } from 'zod';
import { defineCommand, type CommandEndpoint } from '../endpoints.js';
import type { components } from '../generated/api.js';

type Schemas = components['schemas'];
type Body<T> = { [K in keyof T]?: T[K] | undefined };

const consentPreviewSchema = z.object({ clientName: z.string(), redirectHost: z.string() });
const consentResultSchema = z.object({ redirectTo: z.string() });

export type ConsentPreview = Schemas['OAuthConsentPreviewResponse'];

/** What the authorize page received; Core re-validates every field. */
export interface OAuthRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly state?: string | undefined;
  readonly resource?: string | undefined;
}

/** Whether the client and redirect URI are acceptable; the page redirects nowhere before this succeeds. */
export const previewConsent = (
  request: Omit<OAuthRequest, 'state'>,
): CommandEndpoint<ConsentPreview> =>
  defineCommand<ConsentPreview>({
    operation: 'oauth.consent.preview',
    method: 'POST',
    path: '/api/v1/oauth/consent/preview',
    schema: consentPreviewSchema,
    body: request satisfies Body<Schemas['OAuthConsentPreviewRequest']>,
  });

/** Approves (with the access chosen) or denies; the answer is where to send the browser. */
export const decideConsent = (
  request: OAuthRequest & {
    readonly decision: 'approve' | 'deny';
    readonly token?: { readonly scopes: string[] };
  },
): CommandEndpoint<Schemas['OAuthConsentResponse']> =>
  defineCommand<Schemas['OAuthConsentResponse']>({
    operation: 'oauth.consent',
    method: 'POST',
    path: '/api/v1/oauth/consent',
    schema: consentResultSchema,
    body: request satisfies Body<Schemas['OAuthConsentRequest']>,
  });
