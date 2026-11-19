import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { peerClaim, peerIdAt } from '../mcp-peer.ts';
import { runPetPeer } from '../pet-peer-runner.ts';

interface PetPeerWorkerOptions {
  endpoint: string;
  once: boolean;
  credential: string;
  apiKey: string;
}

const claimReply = z.object({
  isError: z.boolean().optional(),
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]),
});

export async function servePetPeer(options: PetPeerWorkerOptions): Promise<void> {
  const endpoint = new URL(options.endpoint);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hash !== '' ||
    endpoint.search !== '' ||
    peerIdAt(endpoint.pathname) === undefined
  ) {
    throw new Error(
      'Use the exact HTTPS pet MCP URL. Loopback HTTP is supported for local development.',
    );
  }
  if (
    !/^nixpeer_[A-Za-z0-9_-]{16,2040}$/.test(options.credential) ||
    options.apiKey.trim() === ''
  ) {
    throw new Error(
      'Set NIX_PET_PEER_TOKEN and a dedicated NIX_PET_PEER_MODEL_KEY for this registered runner.',
    );
  }
  const abort = new AbortController();
  const stop = () => {
    abort.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const client = new Client({ name: 'nix-pet-peer-worker', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          redirect: 'error',
          headers: { authorization: `Bearer ${options.credential}` },
        },
      }),
    );
    do {
      const reply = await client.callTool({ name: 'pet_peer_claim', arguments: {} }, undefined, {
        signal: abort.signal,
      });
      const claim = claimReply.safeParse(reply);
      if (!claim.success || claim.data.isError === true)
        throw new Error('This runner could not claim a job.');
      const { work } = peerClaim.parse(JSON.parse(claim.data.content[0].text));
      if (work === null) {
        if (!options.once) await delay(2_000, undefined, { signal: abort.signal });
        continue;
      }

      let result: string | undefined;
      try {
        result = await runPetPeer({
          runtime: work.runtime,
          endpoint,
          credential: work.credential,
          apiKey: options.apiKey,
          signal: abort.signal,
        });
      } catch {
        // The result receipt reveals failure without echoing provider output or credentials.
      }
      if (abort.signal.aborted) return;
      const finished = await client.callTool(
        {
          name: 'pet_peer_finish',
          arguments: {
            workId: work.workId,
            leaseId: work.leaseId,
            succeeded: result !== undefined,
            result,
          },
        },
        undefined,
        { signal: abort.signal },
      );
      if (finished.isError === true) throw new Error('Core refused the runner result receipt.');
      process.stdout.write(
        JSON.stringify({
          workId: work.workId,
          status: result === undefined ? 'failed' : 'completed',
        }) + '\n',
      );
    } while (!options.once && !abort.signal.aborted);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await client.close();
  }
}
