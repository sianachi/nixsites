import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { boot, SECRET } from '../testing/testing.ts';

const executionId = '50000000-0000-4000-8000-000000000001';
const accessToken = 'test-scoped-github-access-token';
const action = 'github.read_pull_request';
const reviewed = { action, resourceId: 'owner/workspace', args: { pullNumber: 19 } };
const pull = {
  number: 19,
  title: 'Review the connector',
  body: null,
  state: 'open',
  merged: false,
  updated_at: '2026-11-16T12:00:00Z',
  base: { repo: { full_name: 'owner/workspace' } },
  head: { sha: 'a'.repeat(40) },
  user: null,
};

const catalog = z.object({
  actions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['read', 'write']),
      resourceKind: z.string().min(1),
      schema: z.object({ type: z.literal('object') }),
      schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
});
const preparation = z.object({
  arguments: z.object({ pullNumber: z.literal(19) }),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
});

async function withConnector(
  provider: typeof fetch,
  test: (send: (body: unknown, secret?: string) => Promise<Response>) => Promise<void>,
  path = '/v1/sani/connectors',
): Promise<void> {
  const service = await boot({ deps: { fetch: provider } });
  try {
    await test((body, secret = SECRET) =>
      fetch(`${service.url}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Nix-Internal-Secret': secret },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    await service.close();
  }
}

describe('Sani connector HTTP boundary', () => {
  it('requires Core authentication and publishes a classified schema for the selected release providers', async () => {
    const provider = vi.fn<typeof fetch>();
    await withConnector(provider, async (send) => {
      const unauthorized = await send({ operation: 'catalog' }, 'not-the-service-secret');
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get('Cache-Control')).toBe('no-store');
      const result = await send({ operation: 'catalog' });
      expect(result.status).toBe(200);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      const { actions } = catalog.parse(await result.json());
      const ids = actions.map(({ id }) => id);
      expect(new Set(ids).size).toBe(ids.length);
      expect([...new Set(ids.map((id) => id.split('.')[0]))].sort()).toEqual([
        'github',
        'gmail',
        'google-calendar',
        'google-drive',
        'linear',
        'onedrive',
        'outlook-calendar',
        'outlook-mail',
        'slack',
        'teams',
      ]);
      const kinds = new Map(actions.map(({ id, kind }) => [id, kind]));
      expect(kinds.get('linear.update_issue')).toBe('write');
      expect(kinds.get('linear.read_issue')).toBe('read');
      expect(kinds.get('github.post_pull_comment')).toBe('write');
      expect(kinds.get('slack.reply')).toBe('write');
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it('prepares without touching the provider, then refuses unregistered or changed requests', async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(pull));
    await withConnector(provider, async (send) => {
      const prepared = preparation.parse(
        await (await send({ operation: 'prepare', ...reviewed })).json(),
      );
      const execute = {
        operation: 'execute',
        ...reviewed,
        executionId,
        accessToken,
        schemaHash: prepared.schemaHash,
      };
      expect(await (await send({ ...execute, action: 'github.unregistered' })).json()).toEqual({
        failure: 'unknown_action',
      });
      expect(
        await (
          await send({ ...execute, args: { pullNumber: 19, repository: 'other/private' } })
        ).json(),
      ).toEqual({
        failure: 'invalid_args',
      });
      expect(await (await send({ ...execute, schemaHash: '0'.repeat(64) })).json()).toEqual({
        failure: 'schema_changed',
      });
      expect(provider).not.toHaveBeenCalled();
      expect(await (await send(execute)).json()).toMatchObject({
        result: {
          number: 19,
          title: 'Review the connector',
          url: 'https://github.com/owner/workspace/pull/19',
        },
      });
      expect(provider).toHaveBeenCalledTimes(1);
      const request = provider.mock.calls[0];
      if (!request) throw new Error('Expected a provider request.');
      const forwarded = new Request(...request);
      expect(forwarded.url).toBe('https://api.github.com/repos/owner/workspace/pulls/19');
      expect(forwarded.redirect).toBe('error');
    });
  });

  it('refuses redirects and screens projected results that echo a connection credential', async () => {
    const provider = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.redirect('https://unexpected.example/private', 307))
      .mockResolvedValueOnce(Response.json({ ...pull, title: accessToken }));
    await withConnector(provider, async (send) => {
      const prepared = preparation.parse(
        await (await send({ operation: 'prepare', ...reviewed })).json(),
      );
      const request = {
        operation: 'execute',
        ...reviewed,
        executionId,
        accessToken,
        schemaHash: prepared.schemaHash,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await send(request);
        expect(await response.json()).toEqual({ failure: 'provider_unavailable' });
      }
    });
    expect(provider.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/owner/workspace/pulls/19',
      'https://api.github.com/repos/owner/workspace/pulls/19',
    ]);
  });

  it('applies the internal authentication boundary to registered MCP', async () => {
    const provider = vi.fn<typeof fetch>();
    const request = {
      operation: 'inspect',
      resourceId: 'https://127.0.0.1/mcp',
      action: 'get_item',
      accessToken,
    };
    await withConnector(
      provider,
      async (send) => {
        expect((await send(request, 'not-the-service-secret')).status).toBe(401);
        const response = await send(request);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(await response.json()).toEqual({ failure: 'invalid_destination' });
      },
      '/v1/sani/registered-mcp',
    );
    expect(provider).not.toHaveBeenCalled();
  });
});
