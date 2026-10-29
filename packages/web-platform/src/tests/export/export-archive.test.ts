import type { Export, NixClient } from '@nix/api-client';
import { describe, expect, it, vi } from 'vitest';

import {
  fileNameFrom,
  requestArchive,
  saveArchive,
  type ArchiveOutcome,
} from '../../export/export-archive';

const EXPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const ITEM_ID = 'a2222222-2222-4222-8222-222222222222';
const WORKSPACE_ID = 'a3333333-3333-4333-8333-333333333333';

function state(status: Export['status'], overrides: Partial<Export> = {}): Export {
  const completed = status === 'completed';
  return {
    id: EXPORT_ID,
    itemId: ITEM_ID,
    workspaceId: WORKSPACE_ID,
    format: 'nix',
    scope: 'subtree',
    fileName: 'notes.nix',
    mediaType: 'application/vnd.nix.archive+zip',
    status,
    itemCount: completed ? 3 : null,
    omittedCount: completed ? 0 : null,
    byteLength: completed ? 128 : null,
    sha256: completed ? 'a'.repeat(64) : null,
    loss: [],
    omissions: [],
    failureCode: null,
    failureDetail: null,
    cancellationRequested: false,
    downloadReady: completed,
    createdAt: '2026-09-01T09:00:00+00:00',
    completedAt: completed ? '2026-09-01T09:00:02+00:00' : null,
    expiresAt: completed ? '2026-09-02T09:00:02+00:00' : null,
    ...overrides,
  };
}

function capability() {
  return {
    url: 'https://objects.example/private/notes.nix?signature=secret',
    expiresAt: '2999-09-01T09:10:00+00:00',
    fileName: 'notes.nix',
    mediaType: 'application/vnd.nix.archive+zip',
    byteLength: 128,
    sha256: 'a'.repeat(64),
  };
}

interface SeenEndpoint {
  readonly operation: string;
  readonly body?: {
    readonly itemId: string;
    readonly scope: string;
    readonly format: string;
    readonly idempotencyKey: string;
  };
}

function clientFor(states: readonly Export[], download = capability()) {
  const pending = [...states];
  const execute = vi.fn((endpoint: SeenEndpoint) => {
    if (endpoint.operation === 'exports.begin') return Promise.resolve(state('queued'));
    if (endpoint.operation === 'exports.cancel') return Promise.resolve(undefined);
    return Promise.reject(new Error(`Unexpected command ${endpoint.operation}`));
  });
  const query = vi.fn((endpoint: SeenEndpoint) => {
    if (endpoint.operation === 'exports.get') {
      return Promise.resolve(pending.shift() ?? state('completed'));
    }
    if (endpoint.operation === 'exports.download.authorize') {
      return Promise.resolve(download);
    }
    return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
  });
  return {
    client: { execute, query } as unknown as NixClient,
    execute,
    query,
  };
}

function refusalOf(outcome: ArchiveOutcome): string {
  if (outcome.ok) throw new Error('Expected a refusal, but the export succeeded.');
  return outcome.error;
}

describe('requestArchive', () => {
  it('creates and polls a Core job before authorizing its download', async () => {
    const fake = clientFor([state('running'), state('completed')]);
    const progress: string[] = [];

    const outcome = await requestArchive({
      client: fake.client,
      itemId: ITEM_ID,
      scope: 'subtree',
      format: 'nix',
      pollIntervalMs: 10,
      onProgress: (exportState) => progress.push(exportState.status),
    });

    expect(outcome).toMatchObject({
      ok: true,
      value: {
        fileName: 'notes.nix',
        downloadUrl: capability().url,
        itemCount: 3,
        omittedCount: 0,
      },
    });
    expect(progress).toEqual(['queued', 'running', 'completed']);
    const command = fake.execute.mock.calls[0]?.[0];
    expect(command?.operation).toBe('exports.begin');
    expect(command?.body).toMatchObject({
      itemId: ITEM_ID,
      scope: 'subtree',
      format: 'nix',
    });
    expect(command?.body?.idempotencyKey).toMatch(/^web-export:/);
    expect(fake.query.mock.calls.at(-1)?.[0].operation).toBe('exports.download.authorize');
  });

  it('returns the worker failure detail instead of asking for a download', async () => {
    const fake = clientFor([
      state('failed', {
        failureCode: 'export.converter_failed',
        failureDetail: 'The PDF converter rejected this document.',
      }),
    ]);

    const outcome = await requestArchive({
      client: fake.client,
      itemId: ITEM_ID,
      scope: 'item',
      format: 'pdf',
      pollIntervalMs: 10,
    });

    expect(refusalOf(outcome)).toBe('The PDF converter rejected this document.');
    expect(
      fake.query.mock.calls.some(
        ([endpoint]) => endpoint.operation === 'exports.download.authorize',
      ),
    ).toBe(false);
  });

  it('reports durable cancellation separately from a worker failure', async () => {
    const outcome = await requestArchive({
      client: clientFor([state('cancelled')]).client,
      itemId: ITEM_ID,
      scope: 'item',
      format: 'nix',
      pollIntervalMs: 10,
    });

    expect(outcome).toEqual({
      ok: false,
      cancelled: true,
      error: 'The export was cancelled.',
    });
  });

  it('does not claim a download exists when a completed job says it is unavailable', async () => {
    const outcome = await requestArchive({
      client: clientFor([state('completed', { downloadReady: false })]).client,
      itemId: ITEM_ID,
      scope: 'item',
      format: 'nix',
      pollIntervalMs: 10,
    });

    expect(refusalOf(outcome)).toContain('download is not available');
  });

  it('refuses a capability whose checksum does not match the completed job', async () => {
    const outcome = await requestArchive({
      client: clientFor([state('completed')], { ...capability(), sha256: 'b'.repeat(64) }).client,
      itemId: ITEM_ID,
      scope: 'item',
      format: 'nix',
      pollIntervalMs: 10,
    });

    expect(refusalOf(outcome)).toContain('did not match the completed job');
  });
});

describe('saveArchive', () => {
  it('hands the private capability directly to the browser without fetching it into memory', () => {
    const clicked: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function capture(this: HTMLAnchorElement) {
        clicked.push(this);
      });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    saveArchive({
      exportId: EXPORT_ID,
      fileName: 'notes.nix',
      downloadUrl: capability().url,
      capabilityExpiresAt: capability().expiresAt,
      mediaType: capability().mediaType,
      byteLength: capability().byteLength,
      sha256: capability().sha256,
      itemCount: 3,
      omittedCount: 0,
      loss: [],
      omissions: [],
    });

    expect(click).toHaveBeenCalledOnce();
    const anchor = clicked[0];
    expect(anchor?.href).toBe(capability().url);
    expect(anchor?.download).toBe('notes.nix');
    expect(anchor?.referrerPolicy).toBe('no-referrer');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('fileNameFrom', () => {
  it('keeps the legacy template archive name parser bounded to one quoted filename', () => {
    expect(fileNameFrom('attachment; filename="quarterly-review.nix"')).toBe(
      'quarterly-review.nix',
    );
    expect(fileNameFrom(null)).toBe('export.nix');
    expect(fileNameFrom('attachment', 'pdf')).toBe('export.pdf');
  });
});
