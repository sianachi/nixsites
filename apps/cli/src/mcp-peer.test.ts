import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpHttpHandler } from './mcp-http.ts';

const petId = 'f77f851f-f415-4866-b783-df01070d2c55';
const runId = '373e3744-751a-4e01-83bc-b48e4e3275f6';
const clientToken = 'nixpeer_client-test-credential';
const executionToken = 'nixpeer_execution-test-credential';
const coreRequest = z.object({ operation: z.string() });

it('uses fresh Core authorization and exposes only operations bound to each peer credential', async () => {
  let revoked = false;
  const seen: { authorization: string | null; operation: string }[] = [];
  const handler = createMcpHttpHandler({
    apiUrl: 'https://nix-core.test',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const { operation } = coreRequest.parse(await request.json());
      const authorization = request.headers.get('authorization');
      seen.push({ authorization, operation });
      if (request.url !== `https://nix-core.test/public/v1/pet-mcp/${petId}/dispatch` || revoked) {
        return Response.json({}, { status: 401 });
      }
      if (operation === 'probe') {
        const kind = authorization === `Bearer ${clientToken}` ? 'client' : 'execution';
        return Response.json({ kind });
      }
      return Response.json({ id: runId, status: 'queued', revision: 1 });
    },
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing loopback address');
  const root = new URL(`http://127.0.0.1:${String(address.port)}`);
  const endpoint = new URL(`/mcp/pets/${petId}`, root);
  const main = new Client({ name: 'fixture-client', version: '1' });
  const execution = new Client({ name: 'fixture-runner-child', version: '1' });
  const transport = (token: string) =>
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
  try {
    const forbidden = await fetch(endpoint, {
      headers: { authorization: 'Bearer nixpat_fixture' },
    });
    expect(forbidden.status).toBe(401);
    expect(seen).toEqual([]);
    const mainRejected = await fetch(new URL('/mcp', root), {
      headers: { authorization: `Bearer ${clientToken}` },
    });
    expect(mainRejected.status).toBe(401);
    expect(seen).toEqual([]);
    await main.connect(transport(clientToken));
    expect((await main.listTools()).tools.map((tool) => tool.name)).toEqual([
      'pet_run_submit',
      'pet_run_status',
      'pet_run_result',
      'pet_run_cancel',
    ]);
    const reply = await main.callTool(
      {
        name: 'pet_run_status',
        arguments: { runId },
      },
      CallToolResultSchema,
    );
    expect(reply.content).toEqual([
      { type: 'text', text: JSON.stringify({ id: runId, status: 'queued', revision: 1 }) },
    ]);
    expect(seen).toContainEqual({ authorization: `Bearer ${clientToken}`, operation: 'status' });

    await execution.connect(transport(executionToken));
    expect((await execution.listTools()).tools.map((tool) => tool.name)).toEqual([
      'pet_job_assignment',
    ]);
    expect(seen.at(-1)).toEqual({ authorization: `Bearer ${executionToken}`, operation: 'probe' });
    revoked = true;
    const refused = await fetch(endpoint, { headers: { authorization: `Bearer ${clientToken}` } });
    expect(refused.status).toBe(401);
  } finally {
    await Promise.allSettled([main.close(), execution.close()]);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});
