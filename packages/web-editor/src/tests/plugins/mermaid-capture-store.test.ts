import type * as ApiClient from '@nix/api-client';
import type { NixClient } from '@nix/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storeCapture } from '../../plugins/mermaid-capture';

const api = vi.hoisted(() => ({ uploadAndCompleteFile: vi.fn() }));
vi.mock('@nix/api-client', async (original) => {
  const actual = await original<typeof ApiClient>();
  return {
    ...actual,
    files: { ...actual.files, uploadAndCompleteFile: api.uploadAndCompleteFile },
  };
});

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const PAGE = '00000000-0000-4000-8000-000000000002';
const OWN = '00000000-0000-4000-8000-000000000003';
const FOREIGN = '00000000-0000-4000-8000-000000000004';
const NEW = '00000000-0000-4000-8000-000000000005';

interface Endpoint {
  readonly path: string;
  readonly body?: unknown;
}

/** Items and files as Core knows them; `begun` records each upload's request body. */
function fakeClient(files: Record<string, { parentId: string; mediaType: string }>) {
  const begun: Record<string, unknown>[] = [];
  const client = {
    query: vi.fn((endpoint: Endpoint) => {
      const id = /\/items\/([^/]+)/.exec(endpoint.path)?.[1] ?? '';
      const file = files[id];
      if (file === undefined) return Promise.reject(new Error('not found'));
      return Promise.resolve(
        endpoint.path.endsWith('/file')
          ? { itemId: id, workspaceId: WORKSPACE, current: { mediaType: file.mediaType } }
          : { id, workspaceId: WORKSPACE, parentId: file.parentId, type: 'file' },
      );
    }),
    execute: vi.fn((endpoint: Endpoint) => {
      begun.push(endpoint.body as Record<string, unknown>);
      return Promise.resolve({ id: 'upload', uploadUrl: 'https://store.test/u' });
    }),
  };
  return { client: client as unknown as NixClient, begun };
}

const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });

beforeEach(() => {
  api.uploadAndCompleteFile.mockReset().mockResolvedValue({ itemId: NEW });
});

describe('storing a captured picture', () => {
  it('never writes a version into a file the block names but this page does not own', async () => {
    const { client, begun } = fakeClient({
      // A diagram picture of another page, and a document somewhere else entirely.
      [FOREIGN]: { parentId: '00000000-0000-4000-8000-000000000099', mediaType: 'image/svg+xml' },
    });
    const stored = await storeCapture(client, {
      workspaceId: WORKSPACE,
      pageItemId: PAGE,
      svg,
      renderFileId: FOREIGN,
    });

    expect(stored).toBe(NEW);
    expect(begun).toHaveLength(1);
    expect(begun[0]).toMatchObject({ parentId: PAGE, targetItemId: null });
    expect(JSON.stringify(begun)).not.toContain(FOREIGN);
  });

  it('refuses a file under this page that is not an SVG', async () => {
    const { client, begun } = fakeClient({
      [OWN]: { parentId: PAGE, mediaType: 'application/pdf' },
    });
    await storeCapture(client, {
      workspaceId: WORKSPACE,
      pageItemId: PAGE,
      svg,
      renderFileId: OWN,
    });
    expect(begun[0]).toMatchObject({ parentId: PAGE, targetItemId: null });
  });

  it('replaces the picture this page already owns, as a new version', async () => {
    const { client, begun } = fakeClient({ [OWN]: { parentId: PAGE, mediaType: 'image/svg+xml' } });
    await storeCapture(client, {
      workspaceId: WORKSPACE,
      pageItemId: PAGE,
      svg,
      renderFileId: OWN,
    });
    expect(begun[0]).toMatchObject({ parentId: null, targetItemId: OWN });
  });

  it('creates a new file when the named one cannot be read', async () => {
    const { client, begun } = fakeClient({});
    await storeCapture(client, {
      workspaceId: WORKSPACE,
      pageItemId: PAGE,
      svg,
      renderFileId: OWN,
    });
    expect(begun[0]).toMatchObject({ parentId: PAGE, targetItemId: null });
  });
});
