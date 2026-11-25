import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runRegisteredMcp } from './registered-mcp.ts';

const resourceId = 'https://tools.example.org/mcp';
const action = 'create_record';
const accessToken = 'registration-fixture-secret';
const args = { title: 'Reviewed text', labels: ['release'] };
const inputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 48 },
    labels: { type: 'array', items: { type: 'string' }, maxItems: 2 },
  },
  required: ['title'],
};
const outputSchema = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
};
const definition = { name: action, inputSchema, outputSchema };
const inspectRequest = { operation: 'inspect', resourceId, action, accessToken };
const executionId = '19b0afa5-a77d-4fff-b2dd-571ce0f26558';
const packet = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

interface FixtureOptions {
  tools?: unknown[];
  result?: unknown;
  loseCall?: boolean | undefined;
}

function fixture({
  tools = [definition],
  result = {
    structuredContent: { id: 'record-1' },
    content: [
      { type: 'text', text: 'Created record.', annotations: { audience: ['user'] } },
      { type: 'resource_link', name: 'file', uri: 'https://tools.example.org/attachment' },
    ],
    _meta: { trace: 'hidden' },
  },
  loseCall = false,
}: FixtureOptions = {}) {
  const calls: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>((url, options) => {
    expect(url).toEqual(new URL(resourceId));
    expect(new Headers(options?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(options?.method).toBe('POST');
    expect(options?.redirect).toBe('error');
    expect(options).toHaveProperty('dispatcher');
    if (typeof options?.body !== 'string') throw new Error('Fixture needs a JSON-RPC request.');
    const { id, method, params } = packet.parse(JSON.parse(options.body));
    const rpcResult = (body: unknown) =>
      Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: body }));
    switch (method) {
      case 'initialize':
        return rpcResult({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        });
      case 'notifications/initialized':
        return Promise.resolve(new Response(null, { status: 202 }));
      case 'tools/list':
        return rpcResult({ tools });
      case 'tools/call':
        calls.push(params);
        if (loseCall) return Promise.reject(new Error('Fixture lost response after dispatch.'));
        return rpcResult(result);
      default:
        throw new Error('Only discovery and exact tool calls are allowed.');
    }
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}

async function inspect() {
  const reply = await runRegisteredMcp(inspectRequest);
  return z
    .object({
      result: z.object({
        url: z.string(),
        tool: z.string(),
        schema: z.unknown(),
        schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    })
    .parse(reply).result;
}

afterEach(() => vi.unstubAllGlobals());

describe('registered MCP tools', () => {
  it.each([
    'pet_plans',
    'pet_plan_decide',
    'PET.PLAN.DECISION',
    'pet-plan-handoff',
    'pet_sharing_decide',
    'mcp__nix__pet_plans',
    'nix.pet_plan_decide',
  ])('refuses owner decision tool %s before connecting to a remote', async (tool) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    for (const operation of ['inspect', 'prepare', 'execute']) {
      const reviewed = operation === 'inspect' ? {} : { args: {}, schemaHash: 'a'.repeat(64) };
      expect(
        await runRegisteredMcp({
          ...inspectRequest,
          action: tool,
          operation,
          ...reviewed,
          ...(operation === 'execute' ? { executionId } : {}),
        }),
      ).toEqual({ failure: 'unknown_tool' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discovers only the exact tool, prepares without a call, and dispatches the reviewed arguments once', async () => {
    const { calls } = fixture({
      tools: [
        definition,
        {
          name: 'unrelated',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object', $ref: 'https://tools.example.org/unreviewed' },
        },
      ],
    });
    const details = await inspect();
    expect(details).toEqual({
      url: resourceId,
      tool: action,
      schema: inputSchema,
      schemaHash: details.schemaHash,
    });
    const prepared = {
      ...inspectRequest,
      schemaHash: details.schemaHash,
      args,
      operation: 'prepare',
    };
    expect(await runRegisteredMcp(prepared)).toEqual({
      arguments: args,
      schemaHash: details.schemaHash,
    });
    expect(calls).toEqual([]);
    expect(await runRegisteredMcp({ ...prepared, operation: 'execute', executionId })).toEqual({
      result: { structuredContent: { id: 'record-1' }, text: ['Created record.'] },
    });
    expect(calls).toEqual([{ name: action, arguments: args }]);
  });

  it('keeps the schema hash when the server changes object key order', async () => {
    fixture();
    const details = await inspect();
    const { calls } = fixture({
      tools: [
        {
          ...definition,
          inputSchema: { required: ['title'], properties: inputSchema.properties, type: 'object' },
        },
      ],
    });
    expect(
      await runRegisteredMcp({
        ...inspectRequest,
        schemaHash: details.schemaHash,
        args,
        operation: 'execute',
        executionId,
      }),
    ).toEqual({ result: { structuredContent: { id: 'record-1' }, text: ['Created record.'] } });
    expect(calls).toHaveLength(1);
  });

  it.each([
    {
      scenario: 'input change',
      changed: { ...definition, inputSchema: { ...inputSchema, required: ['title', 'labels'] } },
    },
    {
      scenario: 'output change',
      changed: { ...definition, outputSchema: { ...outputSchema, required: [] } },
    },
    { scenario: 'tool substitution', changed: { ...definition, name: 'other_tool' } },
  ])('does not dispatch after a $scenario', async ({ changed }) => {
    fixture();
    const details = await inspect();
    const { calls } = fixture({ tools: [changed] });
    expect(
      await runRegisteredMcp({
        ...inspectRequest,
        schemaHash: details.schemaHash,
        args,
        operation: 'execute',
        executionId,
      }),
    ).toEqual({ failure: changed.name === action ? 'schema_changed' : 'provider_unavailable' });
    expect(calls).toEqual([]);
  });

  it.each([
    { title: 'Reviewed text', other: true },
    { title: 'Reviewed text', labels: [false] },
    { title: '' },
    { title: 'x'.repeat(49) },
    { title: accessToken },
  ])('rejects unreviewable arguments before dispatch', async (invalidArgs) => {
    const { calls } = fixture();
    const details = await inspect();
    const prepare = {
      ...inspectRequest,
      schemaHash: details.schemaHash,
      args: invalidArgs,
      operation: 'prepare',
    };
    expect(await runRegisteredMcp(prepare)).toEqual({ failure: 'invalid_args' });
    expect(await runRegisteredMcp({ ...prepare, operation: 'execute', executionId })).toEqual({
      failure: 'invalid_args',
    });
    expect(calls).toEqual([]);
  });

  it.each([
    { type: 'object', additionalProperties: true },
    { type: 'object', properties: { unsafe: { type: 'string', pattern: '^a+$' } } },
    { type: 'object', properties: { unsafe: { type: 'string', default: 'changed' } } },
    { type: 'object', properties: { unsafe: { $ref: 'https://tools.example.org/unreviewed' } } },
    { type: 'object', properties: { unsafe: { type: 'string', 'x-mcp-header': 'secret' } } },
  ])('fails closed for schema features outside the supported subset', async (schema) => {
    const { calls } = fixture({ tools: [{ ...definition, inputSchema: schema }] });
    expect(await runRegisteredMcp(inspectRequest)).toEqual({ failure: 'unsupported_schema' });
    expect(calls).toEqual([]);
  });

  it.each([
    'http://tools.example.org/mcp',
    'https://127.0.0.1/mcp',
    'https://169.254.169.254/mcp',
    'https://internal.example.local/mcp',
    'https://user:password@tools.example.org/mcp',
    'https://tools.example.org/mcp?redirect=true',
  ])('rejects an invalid endpoint before any network request', async (invalidUrl) => {
    const { fetch } = fixture();
    expect(await runRegisteredMcp({ ...inspectRequest, resourceId: invalidUrl })).toEqual({
      failure: 'invalid_destination',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: 'a credential in text',
      result: {
        structuredContent: { id: 'record-1' },
        content: [{ type: 'text', text: accessToken }],
      },
    },
    {
      scenario: 'a JSON-escaped credential',
      result: {
        structuredContent: { id: 'record-1' },
        content: [{ type: 'text', text: accessToken.replace('e', '\\u0065') }],
      },
    },
    {
      scenario: 'an oversized result',
      result: { structuredContent: { id: 'x'.repeat(64 * 1024) }, content: [] },
    },
    {
      scenario: 'output outside the reviewed schema',
      result: { structuredContent: { id: 3 }, content: [] },
    },
    {
      scenario: 'an upstream tool error',
      result: { isError: true, content: [{ type: 'text', text: 'An upstream failure' }] },
    },
    { scenario: 'loss of the response', loseCall: true },
  ])(
    'reviews an uncertain outcome without exposing $scenario or retrying',
    async ({ result, loseCall }) => {
      const { calls } = fixture({ result, loseCall });
      const details = await inspect();
      expect(
        await runRegisteredMcp({
          ...inspectRequest,
          schemaHash: details.schemaHash,
          args,
          operation: 'execute',
          executionId,
        }),
      ).toEqual({ failure: 'unknown_outcome' });
      expect(calls).toHaveLength(1);
    },
  );
});
