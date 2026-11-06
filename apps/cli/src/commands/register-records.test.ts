import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../index.ts';
import { saveProfile } from '../config.ts';
import { captureStdout, makeProfile } from './cli.test-helper.ts';
import {
  API,
  ITEM,
  OTHER,
  VERSION,
  WORKSPACE,
  fakeApi,
  type Call,
} from './agent-api.test-helper.ts';
import { parseFilter } from './register-records.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

/** Runs `nixctl --json <args>` against the fake API under a token or a login profile. */
async function nixctl(args: string[], kind: 'token' | 'login' = 'token') {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', fakeApi(calls));
  const { env } = await makeProfile({ apiUrl: API, token: 'nixpat_agent' });
  if (kind === 'login')
    await saveProfile(
      'default',
      {
        apiUrl: API,
        token: '',
        interactiveSession: { refreshToken: 'nixcli_x', expiresAt: '2099-01-01T00:00:00.000Z' },
      },
      { makeDefault: true, env },
    );
  vi.stubEnv('XDG_CONFIG_HOME', env.XDG_CONFIG_HOME ?? '');
  vi.stubEnv('NIX_SESSION_TOKEN', undefined);
  const errors: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  });
  const out = await captureStdout(async () => {
    await buildProgram().parseAsync(['--json', ...args], { from: 'user' });
  });
  return {
    calls: calls.filter((call) => call.path.startsWith('/api/')),
    out: out.trim() === '' ? undefined : (JSON.parse(out) as unknown),
    errors: errors.join(''),
  };
}

describe('parseFilter', () => {
  it('keeps colons inside the value', () => {
    expect(parseFilter('url:equals:https://example.com:8443/a')).toEqual({
      property: 'url',
      operator: 'equals',
      value: 'https://example.com:8443/a',
    });
    expect(parseFilter('status:is-empty')).toEqual({ property: 'status', operator: 'is-empty' });
    expect(() => parseFilter('nope')).toThrow('property:operator');
  });
});

describe('nixctl record, query, item and ref commands', () => {
  it('finds by exact property, and queries with filters', async () => {
    const found = await nixctl([
      'item',
      'find',
      '--workspace',
      WORKSPACE,
      '--prop',
      'url=https://example.com/a?x=1',
      '--parent',
      OTHER,
    ]);
    expect(found.calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/workspaces/${WORKSPACE}/lookup`,
      body: { key: 'url', value: 'https://example.com/a?x=1', parentId: OTHER },
    });
    expect(found.out).toMatchObject({ matches: [{ trashed: false }] });
    const queried = await nixctl([
      'query',
      '--workspace',
      WORKSPACE,
      '--filter',
      'status:not-equals:retired',
      '--filter',
      'url:is-not-empty',
      '--sort',
      '$modified:desc',
      '--limit',
      '5',
    ]);
    expect(queried.calls[0]?.body).toMatchObject({
      filters: [
        { property: 'status', operator: 'not-equals', value: 'retired' },
        { property: 'url', operator: 'is-not-empty', value: null },
      ],
      sort: { property: '$modified', descending: true },
      limit: 5,
    });
  });

  it('upserts strictly by default and passes the opt-out and idempotency key', async () => {
    const strict = await nixctl([
      'record',
      'upsert',
      OTHER,
      '--key',
      'url=https://example.com/a',
      '--title',
      'A',
      '--prop',
      'score=5',
      '--prop',
      'status=new',
      '--idempotency-key',
      'k',
    ]);
    expect(strict.calls[0]).toMatchObject({
      path: `/api/v1/items/${OTHER}/records/upsert`,
      body: {
        keyField: 'url',
        keyValue: 'https://example.com/a',
        title: 'A',
        properties: { score: 5, status: 'new' },
        idempotencyKey: 'k',
        strict: true,
      },
    });
    expect(strict.out).toMatchObject({ outcome: 'created' });
    const lenient = await nixctl([
      'record',
      'upsert',
      OTHER,
      '--key',
      'url=https://example.com/a',
      '--no-strict',
    ]);
    expect(lenient.calls[0]?.body).toMatchObject({ strict: false });
  });

  it('creates an item with properties, a key and strictness', async () => {
    const strict = await nixctl([
      'item',
      'create',
      '--workspace',
      WORKSPACE,
      '--title',
      'T',
      '--prop',
      'url=https://example.com/a',
      '--idempotency-key',
      'k',
    ]);
    expect(strict.calls[0]?.body).toMatchObject({
      title: 'T',
      properties: { url: 'https://example.com/a' },
      idempotencyKey: 'k',
      strict: true,
    });
    expect(strict.out).toMatchObject({ properties: { url: 'https://example.com/a' } });
    const lenient = await nixctl([
      'item',
      'create',
      '--workspace',
      WORKSPACE,
      '--title',
      'T',
      '--no-strict',
    ]);
    expect(lenient.calls[0]?.body).toMatchObject({ strict: false });
    const plain = await nixctl([
      'item',
      'create',
      '--workspace',
      WORKSPACE,
      '--title',
      'T',
      '--strict',
    ]);
    expect(plain.calls[0]?.body).toMatchObject({ strict: true });
  });

  it('batches from a file, prints every row, and exits non-zero naming the failed ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-batch-'));
    const file = join(dir, 'rows.json');
    await writeFile(
      file,
      JSON.stringify([
        { parentId: OTHER, title: 'a', idempotencyKey: 'a' },
        { parentId: OTHER, keyField: 'url', keyValue: 'https://example.com/b' },
      ]),
    );
    const result = await nixctl(['record', 'batch', '--workspace', WORKSPACE, '--file', file]);
    expect(result.calls[0]).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE}/records/batch`,
      body: { strict: true },
    });
    expect(result.out).toMatchObject({
      created: 1,
      failed: 1,
      rows: [
        { index: 0, status: 'created' },
        { index: 1, status: 'error' },
      ],
    });
    expect(process.exitCode).toBe(1);
    expect(result.errors).toContain('1 of 2 rows failed');
    expect(result.errors).toContain('row 1 (record.conflict: duplicate url)');
  });

  it('refuses a keyless create row without sending anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nixctl-batch-'));
    const file = join(dir, 'rows.json');
    await writeFile(file, JSON.stringify({ rows: [{ parentId: OTHER, title: 'a' }] }));
    const result = await nixctl(['record', 'batch', '--workspace', WORKSPACE, '--file', file]);
    expect(result.calls).toEqual([]);
    expect(result.errors).toContain('idempotencyKey');
    expect(process.exitCode).not.toBe(0);
  });

  it('adds, removes and lists references, used-by and backlinks', async () => {
    const calls = [
      await nixctl(['ref', 'add', ITEM, OTHER, '--version', VERSION, '--role', 'cv']),
      await nixctl(['ref', 'rm', ITEM, OTHER]),
      await nixctl(['ref', 'ls', ITEM, '--limit', '3']),
      await nixctl(['ref', 'used-by', ITEM]),
      await nixctl(['item', 'backlinks', ITEM, '--limit', '4']),
    ].map((r) => r.calls[0]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${ITEM}/references`,
      body: { targetItemId: OTHER, targetFileVersionId: VERSION, role: 'cv' },
    });
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      path: `/api/v1/items/${ITEM}/references/${OTHER}`,
    });
    expect(calls[2]).toMatchObject({
      path: `/api/v1/items/${ITEM}/references`,
      query: { limit: '3' },
    });
    expect(calls[3]?.path).toBe(`/api/v1/items/${ITEM}/referenced-by`);
    expect(calls[4]).toMatchObject({
      path: `/api/v1/items/${ITEM}/backlinks`,
      query: { limit: '4' },
    });
  });
});

describe('nixctl file, note, item expire and link commands', () => {
  it('sets expiry, requires exactly one of --at and --clear', async () => {
    const set = await nixctl(['item', 'expire', ITEM, '--at', '2099-01-01']);
    expect(set.calls[0]?.body).toEqual({ properties: { expiry: '2099-01-01' } });
    const clear = await nixctl(['item', 'expire', ITEM, '--clear']);
    expect(clear.calls[0]?.body).toEqual({ properties: { expiry: null } });
    const neither = await nixctl(['item', 'expire', ITEM]);
    expect(neither.calls).toEqual([]);
    expect(neither.errors).toContain('exactly one');
  });

  it('sets a version state, lists attachments and exports a note to a file', async () => {
    const state = await nixctl(['file', 'state', ITEM, VERSION, 'approved']);
    expect(state.calls[0]).toMatchObject({
      method: 'PUT',
      path: `/api/v1/items/${ITEM}/file/versions/${VERSION}/state`,
      body: { state: 'approved' },
    });
    const list = await nixctl([
      'file',
      'list',
      '--workspace',
      WORKSPACE,
      '--state',
      'approved',
      '--images',
      '--expiring',
    ]);
    expect(list.calls[0]).toMatchObject({
      path: `/api/v1/workspaces/${WORKSPACE}/attachments`,
      query: { state: 'approved', includeImages: 'true', expiring: 'true' },
    });
    const exported = await nixctl([
      'note',
      'export',
      ITEM,
      '--to-file',
      '--format',
      'docx',
      '--target',
      OTHER,
    ]);
    expect(exported.calls[0]?.body).toMatchObject({
      format: 'docx',
      toFile: true,
      targetItemId: OTHER,
    });
    expect(exported.out).toMatchObject({ itemId: ITEM, publishedVersionId: VERSION });
    const download = await nixctl(['note', 'export', ITEM]);
    expect(download.calls).toEqual([]);
    expect(download.errors).toContain('--to-file');
  });

  it('gets, creates (with --yes) and revokes a public link', async () => {
    expect((await nixctl(['link', 'get', ITEM])).calls[0]?.method).toBe('GET');
    const unconfirmed = await nixctl(['link', 'create', ITEM]);
    expect(unconfirmed.calls).toEqual([]);
    expect(unconfirmed.errors).toContain('--yes');
    const created = await nixctl(['link', 'create', ITEM, '--version', VERSION, '--yes']);
    expect(created.calls[0]).toMatchObject({ method: 'PUT', body: { versionId: VERSION } });
    expect((await nixctl(['link', 'revoke', ITEM])).calls[0]?.method).toBe('DELETE');
  });

  it('refuses approve, revoke and link creation on a login profile, but not draft or review', async () => {
    for (const args of [
      ['file', 'state', ITEM, VERSION, 'approved'],
      ['file', 'state', ITEM, VERSION, 'revoked'],
      ['link', 'create', ITEM, '--yes'],
    ]) {
      const refused = await nixctl(args, 'login');
      expect(refused.calls).toEqual([]);
      expect(refused.errors).toContain('access token');
      expect(refused.errors).toContain('not a security boundary');
    }
    const review = await nixctl(['file', 'state', ITEM, VERSION, 'in_review'], 'login');
    expect(review.errors).not.toContain('not a security boundary');
  });
});
