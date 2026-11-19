import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runLinear } from './linear.ts';

const issuer = 'https://mcp.linear.app';
const endpoint = `${issuer}/mcp/readonly`;
const token = 'example-linear-token';
const escapedToken = Array.from(
  token,
  (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
).join('');
const issueUuid = '7dc91798-f789-41b4-9014-b704afaba1e8';
const input = {
  operation: 'read',
  oauthState: { tokens: { access_token: token, token_type: 'bearer', issuer } },
  callbackUrl: 'https://nix.example/oauth/callback',
  issueId: 'ABC-123',
};
const issue = {
  id: input.issueId,
  title: 'Review task notes',
  status: 'In Progress',
  url: 'https://linear.app/example/issue/ABC-123/review-task-notes',
  description: 'Leave this field out of the worker reply.',
};
const requestPacket = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

function mockLinear(
  reply: (id: string | number | undefined) => Response,
  { advertiseIssue = true, accessToken = token, supportsFields = false } = {},
) {
  const calls: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
    expect(url).toEqual(new URL(endpoint));
    expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(options?.redirect).toBe('error');
    expect(options?.method).toBe('POST');
    if (typeof options?.body !== 'string') throw new Error('Fixture requires a JSON RPC body.');
    const packet = requestPacket.parse(JSON.parse(options.body));
    switch (packet.method) {
      case 'initialize':
        return Promise.resolve(
          Response.json({
            jsonrpc: '2.0',
            id: packet.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'linear-fixture', version: '1' },
            },
          }),
        );
      case 'notifications/initialized':
        return Promise.resolve(new Response(null, { status: 202 }));
      case 'tools/list':
        return Promise.resolve(
          Response.json({
            jsonrpc: '2.0',
            id: packet.id,
            result: {
              tools: advertiseIssue
                ? [
                    {
                      name: 'get_issue',
                      inputSchema: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          ...(supportsFields && {
                            fields: { type: 'array', items: { type: 'string' } },
                          }),
                        },
                        required: ['id'],
                      },
                    },
                  ]
                : [],
            },
          }),
        );
      case 'tools/call':
        calls.push(packet.params);
        return Promise.resolve(reply(packet.id));
      default:
        throw new Error(`Unexpected fixture method: ${packet.method}`);
    }
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

afterEach(() => vi.unstubAllGlobals());

describe('Linear issue reads', () => {
  it.each([
    {
      format: 'structured content',
      result: { content: [], structuredContent: issue },
      issueId: input.issueId,
      fields: ['id', 'title', 'status', 'url'],
    },
    {
      format: 'JSON text',
      result: { content: [{ type: 'text', text: JSON.stringify(issue) }] },
      issueId: input.issueId,
      fields: undefined,
    },
    {
      format: 'structured content with a matching UUID',
      result: { content: [], structuredContent: { ...issue, uuid: issueUuid } },
      issueId: issueUuid,
      fields: ['id', 'title', 'status', 'url', 'uuid'],
    },
  ])('returns only the approved issue fields from $format', async ({ result, issueId, fields }) => {
    const { calls } = mockLinear((id) => Response.json({ jsonrpc: '2.0', id, result }), {
      supportsFields: fields !== undefined,
    });

    expect(await runLinear({ ...input, issueId })).toEqual({
      oauthState: input.oauthState,
      sent: true,
      issue: { id: issue.id, title: issue.title, status: issue.status, url: issue.url },
    });
    expect(calls).toEqual([
      {
        name: 'get_issue',
        arguments: {
          id: issueId,
          ...(fields && { fields }),
        },
      },
    ]);
  });

  it.each([
    {
      scenario: 'a credential in a returned field',
      reply: { result: { content: [], structuredContent: { ...issue, title: token } } },
    },
    {
      scenario: 'a credential materialized by JSON parsing',
      reply: {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...issue, title: token }).replace(token, escapedToken),
            },
          ],
        },
      },
    },
    {
      scenario: 'a payload for a different issue',
      reply: {
        result: {
          content: [],
          structuredContent: {
            ...issue,
            id: 'ABC-999',
            url: 'https://linear.app/example/issue/ABC-999/other',
          },
        },
      },
    },
    {
      scenario: 'an upstream error message',
      reply: { error: { code: -32603, message: `Private error for ${token}` } },
    },
  ])('withholds $scenario after dispatch', async ({ reply }) => {
    const { calls } = mockLinear((id) => Response.json({ jsonrpc: '2.0', id, ...reply }));

    expect(await runLinear(input)).toEqual({
      oauthState: input.oauthState,
      sent: true,
      failure: 'linear_read_failed',
    });
    expect(calls).toHaveLength(1);
  });

  it('reports an undispatched read when the tool is missing', async () => {
    const { calls, fetch } = mockLinear(
      () => {
        throw new Error('The fixture must never dispatch.');
      },
      { advertiseIssue: false },
    );

    expect(await runLinear(input)).toEqual({
      oauthState: input.oauthState,
      sent: false,
      failure: 'linear_read_failed',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls).toEqual([]);
  });

  it('rejects an invalid request before accessing the provider', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);

    expect(await runLinear({ ...input, operation: 'write' })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns rotated OAuth credentials to Core even when the approved read fails', async () => {
    const tokenEndpoint = `${issuer}/oauth/token`;
    const tokens = {
      access_token: 'renewed-linear-token',
      refresh_token: 'rotated-linear-refresh',
      token_type: 'bearer',
    };
    const oauthState = {
      tokens: { ...input.oauthState.tokens, refresh_token: 'previous-linear-refresh' },
      clientInformation: { client_id: 'nix-fixture', issuer },
      discovery: {
        authorizationServerUrl: issuer,
        resourceMetadata: { resource: endpoint, authorization_servers: [issuer] },
        authorizationServerMetadata: {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: tokenEndpoint,
          response_types_supported: ['code'],
        },
      },
    };
    const { calls, fetch } = mockLinear(
      () => new Response('private provider response', { status: 503 }),
      { accessToken: tokens.access_token },
    );
    fetch.mockImplementationOnce((url, options) => {
      expect(url).toEqual(new URL(endpoint));
      expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return Promise.resolve(
        new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
        }),
      );
    });
    fetch.mockImplementationOnce((url, options) => {
      expect(url).toEqual(new URL(tokenEndpoint));
      if (!(options?.body instanceof URLSearchParams))
        throw new Error('Fixture requires a form body.');
      expect(options.body.get('refresh_token')).toBe(oauthState.tokens.refresh_token);
      return Promise.resolve(Response.json(tokens));
    });

    expect(await runLinear({ ...input, oauthState })).toEqual({
      oauthState: { ...oauthState, tokens: { ...tokens, issuer } },
      sent: true,
      failure: 'linear_read_failed',
    });
    expect(calls).toHaveLength(1);
  });
});
