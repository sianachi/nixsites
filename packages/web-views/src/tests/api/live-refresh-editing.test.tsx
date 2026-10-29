import {
  createInMemoryTokenStore,
  createNixClient,
  files,
  items,
  propertyDefinitionSchema,
  structure,
} from '@nix/api-client';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientOverrideProvider } from '@nix/web-platform/api/api-client-provider';
import { PropertyPanel } from '@nix/web-collections/properties/property-panel';
import { useItemProperties } from '@nix/web-collections/properties/use-item-properties';
import { useDriveFileInfo } from '../../drive/use-drive-file-info';
import { item } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';

const NOTE = item({
  id: 'a5000000-0000-4000-8000-000000000001',
  title: 'Draft note',
  properties: { title: 'Draft note', summary: 'Stored summary' },
});
const SUMMARY = propertyDefinitionSchema.parse({
  key: 'summary',
  label: 'Summary',
  type: 'text',
  required: false,
  options: [],
});
const FILE_ID = 'a5000000-0000-4000-8000-000000000002';
const VERSION = {
  id: 'a5000000-0000-4000-8000-000000000003',
  version: 1,
  fileName: 'diagram.png',
  mediaType: 'image/png',
  byteLength: 1234,
  sha256: '1'.repeat(64),
  previewable: true,
  pixelWidth: 40,
  pixelHeight: 20,
  createdAt: '2026-09-01T00:00:00Z',
  current: true,
  thumbnail: { width: 40, height: 20 },
};
const FILE = {
  itemId: FILE_ID,
  workspaceId: NOTE.workspaceId,
  current: VERSION,
  versions: [VERSION],
};

function deferredResponse() {
  let finish: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  return {
    promise,
    resolve: (response: Response) => {
      if (finish === undefined) throw new Error('The response was not initialized.');
      finish(response);
    },
  };
}

function setup(answer: (request: Request) => Response | Promise<Response>) {
  const client = createNixClient({
    baseUrl: window.location.origin,
    tokens: createInMemoryTokenStore({
      initialAccessToken: 'editing-test-token',
      refresh: () => Promise.resolve(null),
    }),
  });
  const requests: Request[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      // Node Request cannot accept jsdom's AbortSignal; preserve only the HTTP request data.
      const request =
        input instanceof Request ? input : new Request(input, { ...init, signal: null });
      requests.push(request);
      return Promise.resolve(answer(request));
    }),
  );
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <ApiClientOverrideProvider client={client}>{children}</ApiClientOverrideProvider>;
  }
  return { client, requests, Wrapper };
}

function NotePanel(): ReactNode {
  const details = useItemProperties(NOTE.id);
  if (details.item === null)
    return details.error === null ? null : <span role="alert">{details.error}</span>;
  return (
    <PropertyPanel
      item={details.item}
      properties={details.schema?.properties ?? []}
      loading={details.loading}
      onChange={details.write}
    />
  );
}

describe('background refresh while editing', () => {
  it.each([
    { label: 'successful item refresh', resource: 'item', status: 200 },
    { label: 'transient item failure', resource: 'item', status: 503 },
    { label: 'transient schema failure', resource: 'schema', status: 503 },
    ...[403, 404, 423].flatMap((status) =>
      ['item', 'schema'].map((resource) => ({
        label: `confirmed ${resource} refusal ${String(status)}`,
        resource,
        status,
      })),
    ),
  ])('handles $label while a property draft has focus', async ({ resource, status }) => {
    const held = deferredResponse();
    let itemReads = 0;
    let schemaReads = 0;
    const schema = { properties: [SUMMARY], declared: [SUMMARY], inherit: true };
    const io = setup((request) => {
      const path = new URL(request.url).pathname;
      if (path === `/api/v1/items/${NOTE.id}/schema`) {
        schemaReads += 1;
        return schemaReads > 1 && resource === 'schema' ? held.promise : json(schema);
      }
      if (path === `/api/v1/items/${NOTE.id}`) {
        itemReads += 1;
        return itemReads > 1 && resource === 'item' ? held.promise : json(NOTE);
      }
      throw new Error(`Unexpected Core request: ${request.method} ${path}`);
    });
    render(<NotePanel />, { wrapper: io.Wrapper });
    const control = await screen.findByRole('textbox', { name: 'Summary' });
    const user = userEvent.setup();
    await user.clear(control);
    await user.type(control, 'Unsent summary');

    act(() => {
      io.client.invalidate(['items', 'a5000000-0000-4000-8000-000000000004']);
    });
    await waitFor(() => {
      expect(itemReads).toBe(2);
      expect(schemaReads).toBe(2);
    });
    expect(screen.getByRole('textbox', { name: 'Summary' })).toBe(control);
    expect(control).toHaveValue('Unsent summary');
    expect(control).toHaveFocus();

    await act(async () => {
      const finished =
        resource === 'schema'
          ? io.client.query(structure.effectiveSchema(NOTE.id), { forceRefresh: true })
          : io.client.query(items.itemById(NOTE.id), { forceRefresh: true });
      held.resolve(
        status === 200
          ? json(NOTE)
          : json(
              {
                status,
                title: 'Refresh unavailable',
                detail: 'Refresh unavailable',
                code: 'test.refresh_unavailable',
              },
              status,
            ),
      );
      await finished.catch(() => undefined);
    });
    if (status === 200 || status === 503) {
      expect(screen.getByRole('textbox', { name: 'Summary' })).toBe(control);
      expect(control).toHaveValue('Unsent summary');
      expect(control).toHaveFocus();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } else {
      expect(screen.queryByRole('textbox', { name: 'Summary' })).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Refresh unavailable');
    }
    expect(io.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it.each(['item', 'schema'])(
    'clears an immediate %s refusal while the other read is held',
    async (resource) => {
      const peer = deferredResponse();
      const schema = { properties: [SUMMARY], declared: [SUMMARY], inherit: true };
      let refreshing = false;
      const io = setup((request) => {
        const path = new URL(request.url).pathname;
        const reading = path === `/api/v1/items/${NOTE.id}/schema` ? 'schema' : 'item';
        if (path !== `/api/v1/items/${NOTE.id}/schema` && path !== `/api/v1/items/${NOTE.id}`)
          throw new Error(`Unexpected Core request: ${request.method} ${path}`);
        if (!refreshing) return json(reading === 'schema' ? schema : NOTE);
        return reading !== resource
          ? peer.promise
          : json({ status: 403, code: 'test.access_revoked', detail: 'Access revoked' }, 403);
      });
      const { result } = renderHook(() => useItemProperties(NOTE.id), { wrapper: io.Wrapper });
      await waitFor(() => {
        expect(result.current.item?.id).toBe(NOTE.id);
      });

      act(() => {
        refreshing = true;
        io.client.invalidate(['items', NOTE.id]);
      });
      await waitFor(() => {
        expect(result.current.error).toBe('Access revoked');
        expect(result.current.item).toBeNull();
        expect(result.current.schema).toBeNull();
        expect(result.current.loading).toBe(false);
      });

      await act(async () => {
        peer.resolve(json(resource === 'schema' ? NOTE : schema));
        await peer.promise;
      });
      expect(result.current.item).toBeNull();
      expect(result.current.schema).toBeNull();
      expect(result.current.error).toBe('Access revoked');
    },
  );

  it.each([true, false])(
    'refreshes a stored value while an unsent draft is %s',
    async (editing) => {
      let current = NOTE;
      let itemReads = 0;
      const property = propertyDefinitionSchema.parse({ ...SUMMARY, type: 'long_text' });
      const io = setup((request) => {
        const path = new URL(request.url).pathname;
        if (path === `/api/v1/items/${NOTE.id}/schema`)
          return json({ properties: [property], declared: [property], inherit: true });
        if (path === `/api/v1/items/${NOTE.id}`) {
          itemReads += 1;
          return json(current);
        }
        throw new Error(`Unexpected Core request: ${request.method} ${path}`);
      });
      render(<NotePanel />, { wrapper: io.Wrapper });
      const control = await screen.findByRole('textbox', { name: 'Summary' });
      const user = userEvent.setup();
      await user.click(control);
      if (editing) {
        await user.clear(control);
        await user.type(control, 'Unsent summary');
      }

      act(() => {
        current = { ...NOTE, properties: { ...NOTE.properties, summary: 'Remote summary' } };
        io.client.invalidate(['items', NOTE.id]);
      });
      await waitFor(() => {
        expect(itemReads).toBe(2);
        expect(control).toHaveValue(editing ? 'Unsent summary' : 'Remote summary');
      });
      expect(control).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(control).toHaveValue('Remote summary');
      await user.tab();
      expect(io.requests.every((request) => request.method === 'GET')).toBe(true);
    },
  );

  it('does not restore refused fields from an earlier accepted write', async () => {
    const written = deferredResponse();
    const schema = { properties: [SUMMARY], declared: [SUMMARY], inherit: true };
    let refused = false;
    const io = setup((request) => {
      const path = new URL(request.url).pathname;
      if (path === `/api/v1/items/${NOTE.id}/properties`) return written.promise;
      if (path === `/api/v1/items/${NOTE.id}/schema`) return json(schema);
      if (path === `/api/v1/items/${NOTE.id}`)
        return refused
          ? json({ status: 403, code: 'test.access_revoked', detail: 'Access revoked' }, 403)
          : json(NOTE);
      throw new Error(`Unexpected Core request: ${request.method} ${path}`);
    });
    const { result } = renderHook(() => useItemProperties(NOTE.id), { wrapper: io.Wrapper });
    await waitFor(() => {
      expect(result.current.item?.id).toBe(NOTE.id);
    });
    let pendingWrite: Promise<string | null> | undefined;
    act(() => {
      pendingWrite = result.current.write({ summary: 'Saved summary' });
    });
    await waitFor(() => {
      expect(io.requests.some((request) => request.method === 'PATCH')).toBe(true);
    });
    act(() => {
      refused = true;
      io.client.invalidate(['items', NOTE.id]);
    });
    await waitFor(() => {
      expect(result.current.item).toBeNull();
      expect(result.current.error).toBe('Access revoked');
    });
    await act(async () => {
      written.resolve(
        json({ ...NOTE, properties: { ...NOTE.properties, summary: 'Saved summary' } }),
      );
      await pendingWrite;
    });
    expect(result.current.item).toBeNull();
    expect(result.current.schema).toBeNull();
    expect(result.current.error).toBe('Access revoked');
  });

  it.each([503, 403, 404, 423])(
    'keeps loaded drive facts during refresh and handles a %i response',
    async (status) => {
      const held = deferredResponse();
      let reads = 0;
      const io = setup((request) => {
        const path = new URL(request.url).pathname;
        if (path !== `/api/v1/items/${FILE_ID}/file`)
          throw new Error(`Unexpected Core request: ${request.method} ${path}`);
        reads += 1;
        return reads === 1 ? json(FILE) : held.promise;
      });
      const { result } = renderHook(() => useDriveFileInfo([FILE_ID]), { wrapper: io.Wrapper });
      await waitFor(() => {
        expect(result.current.get(FILE_ID)).toEqual({ status: 'ready', record: FILE });
      });

      act(() => {
        io.client.invalidate(['files', FILE_ID]);
      });
      await waitFor(() => {
        expect(reads).toBe(2);
      });
      expect(result.current.get(FILE_ID)).toEqual({ status: 'ready', record: FILE });

      await act(async () => {
        const finished = io.client
          .query(files.fileByItem(FILE_ID), { forceRefresh: true })
          .catch(() => undefined);
        held.resolve(
          json(
            {
              status,
              title: 'Refresh refused',
              detail: 'Refresh refused',
              code: 'test.refresh_refused',
            },
            status,
          ),
        );
        await finished;
      });
      expect(result.current.get(FILE_ID)).toEqual(
        status === 503 ? { status: 'ready', record: FILE } : { status: 'error' },
      );
      expect(reads).toBe(2);
    },
  );
});
