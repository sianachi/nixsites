import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import type { CoreImportClient } from './core.ts';
import { createImportBodyService } from './bodies.ts';

const IMPORT = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL = '33333333-3333-4333-8333-333333333333';
const WORKSPACE = '44444444-4444-4444-8444-444444444444';
const ITEM = '55555555-5555-4555-8555-555555555555';

describe('staged import body materialization', () => {
  it('turns Markdown into a hidden Collaboration document only for the authorized mapping', async () => {
    const commands: string[] = [];
    const pool = fakePool(commands);
    const core = fakeCore([
      { sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
      {
        sourceId: 'original',
        targetItemId: '66666666-6666-4666-8666-666666666666',
        itemType: 'file',
        bodyRequired: false,
      },
    ]);
    const service = createImportBodyService({ pool, core });

    await expect(
      service.write({
        importId: IMPORT,
        jobId: '77777777-7777-4777-8777-777777777777',
        executionId: 'worker:lease',
        body: { writes: [{ sourceId: 'root', body: { encoding: 'markdown', text: '# Title' } }] },
      }),
    ).resolves.toEqual({ written: 1 });

    expect(commands.some((command) => command.includes('INSERT INTO content_update'))).toBe(true);
  });

  it('turns a nix-render tree from the worker into a document, and refuses another version', async () => {
    const commands: string[] = [];
    const service = createImportBodyService({
      pool: fakePool(commands),
      core: fakeCore([
        { sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
      ]),
    });
    const request = (version: number) => ({
      importId: IMPORT,
      jobId: '77777777-7777-4777-8777-777777777777',
      executionId: 'worker:lease',
      body: {
        writes: [
          {
            sourceId: 'root',
            body: {
              encoding: 'nix-render',
              render: {
                format: 'nix-render',
                version,
                blocks: [{ kind: 'heading', level: 1, runs: [{ text: 'Title' }] }],
                losses: [],
              },
            },
          },
        ],
      },
    });

    await expect(service.write(request(1))).resolves.toEqual({ written: 1 });
    expect(commands.some((command) => command.includes('INSERT INTO content_update'))).toBe(true);
    await expect(service.write(request(2))).rejects.toMatchObject({
      status: 422,
      code: 'import_body_invalid',
    });
  });

  it('rejects an incomplete body set before opening a database connection', async () => {
    let connected = false;
    const pool = {
      connect: () => {
        connected = true;
        throw new Error('database should not be reached');
      },
    } as unknown as Pool;
    const service = createImportBodyService({
      pool,
      core: fakeCore([
        { sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
      ]),
    });

    await expect(
      service.write({
        importId: IMPORT,
        jobId: '77777777-7777-4777-8777-777777777777',
        executionId: 'worker:lease',
        body: { writes: [] },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'import_body_invalid' });
    expect(connected).toBe(false);
  });

  it('refuses a text encoding with no text instead of silently publishing an empty note', async () => {
    let connected = false;
    const pool = {
      connect: () => {
        connected = true;
        throw new Error('database should not be reached');
      },
    } as unknown as Pool;
    const service = createImportBodyService({
      pool,
      core: fakeCore([
        { sourceId: 'root', targetItemId: ITEM, itemType: 'note', bodyRequired: true },
      ]),
    });

    await expect(
      service.write({
        importId: IMPORT,
        jobId: '77777777-7777-4777-8777-777777777777',
        executionId: 'worker:lease',
        body: { writes: [{ sourceId: 'root', body: { encoding: 'plain_text' } }] },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'import_body_invalid' });
    expect(connected).toBe(false);
  });
});

function fakeCore(
  items: readonly {
    readonly sourceId: string;
    readonly targetItemId: string;
    readonly itemType: string;
    readonly bodyRequired: boolean;
  }[],
): CoreImportClient {
  return {
    authorizeBodies: () =>
      Promise.resolve({
        tenantId: TENANT,
        principalId: PRINCIPAL,
        workspaceId: WORKSPACE,
        importId: IMPORT,
        items,
        canWrite: true,
      }),
  };
}

function fakePool(commands: string[]): Pool {
  const client = {
    query: (text: string, values?: readonly unknown[]) => {
      commands.push(text);
      const rows = text.includes('nix_fence_worker_execution')
        ? [{ authorized: true }]
        : text.includes('RETURNING item_id')
          ? ((values?.[4] ?? []) as string[]).map((item_id) => ({ item_id }))
          : [];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    release: () => undefined,
  };
  return { connect: () => Promise.resolve(client) } as unknown as Pool;
}
