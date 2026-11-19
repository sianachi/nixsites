import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

import { Remote, type OAuthState } from './vendor/remote.ts';
import { assertScreened } from './vendor/screen.ts';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const issuer = 'https://mcp.linear.app';
const endpoint = `${issuer}/mcp/readonly`;
const issueIdentifier = /^[A-Z][A-Z0-9_-]{0,30}-[1-9][0-9]{0,11}$/i;
const linearId = z
  .union([z.guid(), z.string().regex(issueIdentifier)])
  .refine((id) => id === id.trim());

const oauthState = z.object({
  clientInformation: z
    .union([OAuthClientInformationFullSchema, OAuthClientInformationSchema])
    .optional(),
  tokens: OAuthTokensSchema.optional(),
  verifier: z.string().min(1).max(256).optional(),
  discovery: z
    .object({
      authorizationServerUrl: z.string(),
      resourceMetadataUrl: z.string().optional(),
      resourceMetadata: OAuthProtectedResourceMetadataSchema.optional(),
      authorizationServerMetadata: z
        .union([OAuthMetadataSchema, OpenIdProviderDiscoveryMetadataSchema])
        .optional(),
    })
    .optional(),
});

const callbackUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.href.includes('?') &&
      !url.href.includes('#')
    );
  });

const request = z.strictObject({
  operation: z.enum(['authorize', 'complete', 'read']),
  oauthState,
  callbackUrl,
  state: z.string().min(1).max(500).nullish(),
  code: z.string().min(1).max(4096).nullish(),
  issueId: linearId.nullish(),
});

const issueFields = z.object({
  id: linearId,
  uuid: z.guid().optional(),
  identifier: z.string().regex(issueIdentifier).optional(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^\P{Cc}+$/u),
  status: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^\P{Cc}+$/u),
  url: z.url().max(2048),
});

type Issue = Pick<z.infer<typeof issueFields>, 'id' | 'title' | 'status' | 'url'>;

interface LinearReply {
  oauthState: OAuthState;
  sent?: boolean;
  authorizationUrl?: string;
  issue?: Issue;
  failure?: string;
}

function screenIssue(result: CallToolResult, requested: string, secrets: readonly string[]): Issue {
  if (result.isError) throw new Error('Linear refused the issue lookup');
  assertScreened(result, secrets);
  let data: unknown = result.structuredContent;
  if (data === undefined && result.content.length === 1 && result.content[0]?.type === 'text') {
    data = JSON.parse(result.content[0].text);
  }
  const { id, uuid, identifier, title, status, url } = issueFields.parse(data);
  const link = new URL(url);
  const path = /^\/(?:[^/]+\/)?issue\/([^/]+)(?:\/[^/]+)?\/?$/.exec(link.pathname);
  const linkIdentifier = path?.[1]?.toUpperCase();
  if (
    link.origin !== 'https://linear.app' ||
    link.username ||
    link.password ||
    link.href.includes('?') ||
    link.href.includes('#') ||
    linkIdentifier === undefined ||
    !issueIdentifier.test(linkIdentifier) ||
    (issueIdentifier.test(id) && id.toUpperCase() !== linkIdentifier) ||
    (identifier !== undefined && identifier.toUpperCase() !== linkIdentifier) ||
    ![id.toUpperCase(), uuid?.toUpperCase(), linkIdentifier].includes(requested.toUpperCase())
  ) {
    throw new Error('Linear returned an unexpected issue');
  }
  const issue = { id, title, status, url: link.href };
  assertScreened(issue, secrets);
  return issue;
}

function addSecrets(state: OAuthState, secrets: Set<string>): void {
  for (const value of [
    state.clientInformation?.client_secret,
    state.tokens?.access_token,
    state.tokens?.refresh_token,
    state.tokens?.id_token,
    state.verifier,
  ]) {
    if (value) secrets.add(value);
  }
}

/** Trusted Core entry point. Provider errors and unprojected outputs stay inside the worker. */
export async function runLinear(input: unknown): Promise<LinearReply | undefined> {
  const parsed = request.safeParse(input);
  if (!parsed.success) return;
  const { operation, callbackUrl: redirect, state, code, issueId } = parsed.data;
  const initial = parsed.data.oauthState;
  let oauthState: OAuthState = {
    ...(initial.clientInformation && { clientInformation: initial.clientInformation }),
    ...(initial.tokens && { tokens: initial.tokens }),
    ...(initial.verifier && { verifier: initial.verifier }),
    ...(initial.discovery && {
      discovery: {
        authorizationServerUrl: initial.discovery.authorizationServerUrl,
        ...(initial.discovery.resourceMetadataUrl && {
          resourceMetadataUrl: initial.discovery.resourceMetadataUrl,
        }),
        ...(initial.discovery.resourceMetadata && {
          resourceMetadata: initial.discovery.resourceMetadata,
        }),
        ...(initial.discovery.authorizationServerMetadata && {
          authorizationServerMetadata: initial.discovery.authorizationServerMetadata,
        }),
      },
    }),
  };
  const secrets = new Set<string>();
  addSecrets(oauthState, secrets);
  const remote = new Remote({
    url: endpoint,
    auth: { kind: 'oauth', issuer, scope: 'read', state: oauthState },
    callbackUrl: redirect,
    saveOAuth(updated) {
      oauthState = updated;
      addSecrets(updated, secrets);
    },
  });

  let sent = false;
  try {
    switch (operation) {
      case 'authorize': {
        if (!state) return;
        const authorizationUrl = await remote.startOAuth(state);
        assertScreened(authorizationUrl, [...secrets]);
        return { oauthState, authorizationUrl };
      }
      case 'complete':
        if (!code) return;
        await remote.finishOAuth(code);
        return { oauthState };
      case 'read': {
        if (!issueId) return;
        if (!oauthState.tokens) return { oauthState, sent, failure: 'linear_read_failed' };
        const result = await remote.call(
          'get_issue',
          (tool) => {
            const fields = ['id', 'title', 'status', 'url'];
            if (!issueIdentifier.test(issueId)) fields.push('uuid');
            const args = {
              id: issueId,
              ...(Object.hasOwn(tool.inputSchema.properties ?? {}, 'fields') && { fields }),
            };
            assertScreened(args, [...secrets]);
            return args;
          },
          () => {
            sent = true;
          },
        );
        const issue = screenIssue(result, issueId, [...secrets]);
        return { oauthState, sent, issue };
      }
    }
  } catch {
    return {
      oauthState,
      ...(operation === 'read' && { sent }),
      failure: `linear_${operation}_failed`,
    };
  }
}
