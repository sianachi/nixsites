import { afterEach, describe, expect, it } from 'vitest';

import { readConfig } from '../core/config.ts';
import { jsonResponse, startServer, type FakeServer } from '../testing/testing.ts';
import { createServerTools, ownerClock, tokenUsable } from './server-tools.ts';

const WS = '0192f0e0-0000-7000-8000-000000000001';
const ITEM = '0192f0e0-0000-7000-8000-000000000002';

const jwt = (expiresInMs: number): string =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) })).toString('base64url')}.s`;

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function run(
  token: string,
  reply: (res: Parameters<Parameters<typeof startServer>[0]>[1]) => void,
) {
  server = await startServer((_seen, res) => {
    reply(res);
  });
  const tools = createServerTools({
    ...readConfig({
      NIX_COMPANION_DATA_DIR: '/data',
      NIX_COMPANION_INTERNAL_SECRET: 's',
      NIX_COMPANION_API_URL: server.url,
      NIX_COMPANION_SERVER_TOOLS: 'reads',
      NIX_COMPANION_COLLAB_URL: server.url,
    }),
  });
  if (tools === undefined) throw new Error('server tools are off');
  const out = await tools.run(
    {
      token,
      workspaceId: WS,
      args: JSON.stringify({
        operation: 'read_note',
        itemId: ITEM,
        parentId: '',
        title: '',
        markdown: '',
        query: '',
        propertiesJson: '',
        specJson: '',
      }),
      timeZone: 'UTC',
      toolId: 't',
      claimId: 'c',
    },
    AbortSignal.timeout(5000),
  );
  return { out, seen: server.seen };
}

describe('configuration', () => {
  const base = {
    NIX_COMPANION_DATA_DIR: '/data',
    NIX_COMPANION_INTERNAL_SECRET: 's',
    NIX_COMPANION_API_URL: 'http://nix-api:5014',
  };
  it('defaults to off, with no tools object', () => {
    const config = readConfig(base);
    expect(config.serverTools).toBe('off');
    expect(createServerTools(config)).toBeUndefined();
  });
  it('accepts reads and all, and refuses anything else', () => {
    const collab = { NIX_COMPANION_COLLAB_URL: 'http://nix-node:8100/' };
    expect(readConfig({ ...base, ...collab, NIX_COMPANION_SERVER_TOOLS: 'reads' })).toMatchObject({
      serverTools: 'reads',
      collabUrl: 'http://nix-node:8100',
    });
    expect(readConfig({ ...base, ...collab, NIX_COMPANION_SERVER_TOOLS: 'all' }).serverTools).toBe(
      'all',
    );
    expect(() => readConfig({ ...base, ...collab, NIX_COMPANION_SERVER_TOOLS: 'yes' })).toThrow(
      'off, reads or all',
    );
  });
  it('needs the Collab origin once tools are on', () => {
    expect(() => readConfig({ ...base, NIX_COMPANION_SERVER_TOOLS: 'reads' })).toThrow(
      'NIX_COMPANION_COLLAB_URL is required',
    );
  });
});

describe('helpers', () => {
  it('treats a token near or past expiry, or not a JWT, as unusable', () => {
    expect(tokenUsable(jwt(10 * 60_000))).toBe(true);
    expect(tokenUsable(jwt(10_000))).toBe(false);
    expect(tokenUsable(jwt(100_000))).toBe(false); // would expire inside a 90 s read
    expect(tokenUsable(jwt(130_000))).toBe(true);
    expect(tokenUsable(jwt(-60_000))).toBe(false);
    expect(tokenUsable('nonsense')).toBe(false);
  });
  it('lets a write token that outlives a 60 s write plus 30 s through', () => {
    expect(tokenUsable(jwt(115_000), Date.now(), 60_000)).toBe(true);
    expect(tokenUsable(jwt(85_000), Date.now(), 60_000)).toBe(false);
  });
  it('reports the owner zone and falls back to UTC for an unknown one', () => {
    expect(ownerClock('Pacific/Kiritimati').timeZone()).toBe('Pacific/Kiritimati');
    expect(ownerClock('Not/AZone').timeZone()).toBe('UTC');
    expect(ownerClock('UTC').today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('server-run reads', () => {
  it('leaves an expired token to the app without calling Core', async () => {
    const { out, seen } = await run(jwt(-1000), (res) => jsonResponse(res, 200, {}));
    expect(out).toEqual({ kind: 'app' });
    expect(seen).toHaveLength(0);
  });
  it('fails an approved write whose token Core refused, instead of leaving it to the app', async () => {
    server = await startServer((_seen, res) => {
      jsonResponse(res, 401, { title: 'no', status: 401 });
    });
    const tools = createServerTools({
      ...readConfig({
        NIX_COMPANION_DATA_DIR: '/data',
        NIX_COMPANION_INTERNAL_SECRET: 's',
        NIX_COMPANION_API_URL: server.url,
        NIX_COMPANION_SERVER_TOOLS: 'all',
        NIX_COMPANION_COLLAB_URL: server.url,
      }),
    });
    const out = await tools?.run(
      {
        token: jwt(110_000),
        workspaceId: WS,
        args: JSON.stringify({
          operation: 'rename_item',
          itemId: ITEM,
          title: 'x',
          parentId: '',
          markdown: '',
          query: '',
          propertiesJson: '',
          specJson: '',
        }),
        timeZone: 'UTC',
        toolId: 't',
        claimId: 'c',
      },
      AbortSignal.timeout(5000),
      true,
    );
    expect(out).toMatchObject({ kind: 'result', success: false });
  });
  it.each([401, 429])('leaves a %i to the app', async (status) => {
    const { out } = await run(jwt(600_000), (res) =>
      jsonResponse(res, status, { title: 'no', status }),
    );
    expect(out).toEqual({ kind: 'app', stopToken: true });
  });
  it('leaves a locked item to the app', async () => {
    const { out } = await run(jwt(600_000), (res) =>
      jsonResponse(
        res,
        423,
        { title: 'locked', status: 423, code: 'items.locked' },
        { 'Content-Type': 'application/problem+json' },
      ),
    );
    expect(out).toEqual({ kind: 'app' });
  });
  it('leaves a file item to the app', async () => {
    const { out } = await run(jwt(600_000), (res) =>
      jsonResponse(res, 200, {
        id: ITEM,
        workspaceId: WS,
        title: 'Scan',
        type: 'file',
        parentId: null,
        hasChildren: false,
        seq: 1,
        lifecycleState: 'active',
        properties: {},
        createdAt: '2026-11-10T00:00:00Z',
        updatedAt: '2026-11-10T00:00:00Z',
        isDeleted: false,
      }),
    );
    expect(out).toEqual({ kind: 'app' });
  });
  it('turns any other failure into the uncertain-result text', async () => {
    const { out } = await run(jwt(600_000), (res) =>
      jsonResponse(res, 500, { title: 'boom', status: 500 }),
    );
    expect(out).toMatchObject({ kind: 'result', success: false });
  });
});
