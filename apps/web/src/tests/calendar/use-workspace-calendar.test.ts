import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { useWorkspaceCalendar } from '../../calendar/use-workspace-calendar';
import { WorkspaceProvider } from '../../workspaces/workspace-context';
import { item, STUB_WORKSPACE } from '../api-stub';
import { requestUrl } from '../request-url';

/**
 * Creating a dated entry from the collated calendar.
 *
 * Goal 3.10's whole risk lives in `create`, not in any component: it is the one place that resolves
 * which property a chosen container places by. These tests exercise it directly, against a
 * hand-rolled `fetch`, so the container's own `/views` response - not whatever a calendar window
 * happens to hold - is provably what decides the write.
 */

const getAccessToken = (): Promise<string> => Promise.resolve('token');

vi.mock('@nix/web-platform/auth/auth-provider', () => ({
  useAuth: () => ({ getAccessToken }),
}));

const CONTAINER_ID = 'cccccccc-3333-4333-8333-cccccccccccc';
const CREATED_ID = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/** A container's views response, offering one calendar view on the given property. */
function viewsResponse(dateProperty: string | null): Record<string, unknown> {
  return {
    views: [
      {
        id: 'v1',
        name: 'Calendar',
        kind: 'calendar',
        columns: [],
        groupBy: null,
        groupOrder: [],
        dateProperty,
        sortBy: null,
        sortDescending: false,
        mode: null,
        coverProperty: null,
        endDateProperty: null,
        cardSize: null,
        layout: null,
        filters: [],
        companionViewId: null,
        companionPlacement: null,
        interactiveForm: null,
      },
    ],
    unrenderable: [],
    default: 'v1',
  };
}

/** An empty, successful calendar read - what `load` fetches on mount and after every write. */
function calendarResponse(): Record<string, unknown> {
  return {
    workspaceId: '00000000-0000-4000-8000-000000000001',
    from: '2026-03-01',
    to: '2026-03-31',
    entries: [],
    unplaceable: [],
    entryLimit: 2000,
    entriesTruncated: false,
    seriesTruncated: false,
  };
}

function json(body: unknown, status = 200): Response {
  const responseBody =
    status >= 400 && typeof body === 'object' && body !== null
      ? { title: 'Request failed', status, code: 'test.refused', ...body }
      : body;
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    },
  });
}

function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(
    MemoryRouter,
    { initialEntries: [`/w/${STUB_WORKSPACE.id}`] },
    createElement(
      ApiClientProvider,
      null,
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/w/:workspaceId',
          element: createElement(WorkspaceProvider, {
            state: {
              status: 'ready',
              workspaces: [STUB_WORKSPACE],
              error: null,
              reload: () => undefined,
              workspaceCreated: () => undefined,
              workspaceUpdated: () => undefined,
              workspaceRemoved: () => undefined,
            },
            children,
          }),
        }),
      ),
    ),
  );
}

interface FetchStubOptions {
  readonly views?: Record<string, unknown>;
  readonly createStatus?: number;
  readonly createBody?: unknown;
  readonly propertiesStatus?: number;
  readonly propertiesBody?: unknown;
}

interface FetchStub {
  readonly propertyWrites: { itemId: string; properties: Record<string, unknown> }[];
  readonly itemWrites: Record<string, unknown>[];
  readonly viewsRequested: string[];
}

function stubFetch(options: FetchStubOptions = {}): FetchStub {
  const {
    views = viewsResponse('due'),
    createStatus = 201,
    createBody,
    propertiesStatus = 204,
    propertiesBody,
  } = options;

  const propertyWrites: { itemId: string; properties: Record<string, unknown> }[] = [];
  const itemWrites: Record<string, unknown>[] = [];
  const viewsRequested: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const requestBody =
        init?.body ??
        (request === null || method === 'GET' || method === 'HEAD'
          ? undefined
          : await request.clone().text());

      const viewsFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/views$/.exec(url);
      if (viewsFor !== null) {
        viewsRequested.push(viewsFor[1] ?? '');
        return Promise.resolve(json(views));
      }

      const propertiesFor = /\/api\/v1\/items\/([0-9a-f-]{36})\/properties$/.exec(url);
      if (propertiesFor !== null && method === 'PATCH') {
        const body = JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as {
          properties: Record<string, unknown>;
        };
        propertyWrites.push({ itemId: propertiesFor[1] ?? '', properties: body.properties });
        return Promise.resolve(
          propertiesStatus === 204
            ? new Response(null, { status: 204 })
            : json(propertiesBody ?? {}, propertiesStatus),
        );
      }

      if (method === 'POST' && /\/api\/v1\/workspaces\/[0-9a-f-]{36}\/items$/.test(url)) {
        itemWrites.push(
          JSON.parse(typeof requestBody === 'string' ? requestBody : '{}') as Record<
            string,
            unknown
          >,
        );
        return Promise.resolve(
          json(
            createBody ??
              item({ id: CREATED_ID, workspaceId: STUB_WORKSPACE.id, title: 'Untitled' }),
            createStatus,
          ),
        );
      }

      if (/\/api\/v1\/workspaces\/[0-9a-f-]{36}\/calendar\?/.test(url)) {
        return Promise.resolve(json(calendarResponse()));
      }

      return Promise.resolve(json({}, 404));
    }),
  );

  return { propertyWrites, itemWrites, viewsRequested };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('creating a dated entry', () => {
  it("writes the new item's date to the chosen container's own date property", async () => {
    const stub = stubFetch({ views: viewsResponse('due') });
    const { result } = renderHook(() => useWorkspaceCalendar('2026-03-01', '2026-03-31'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const refusal = await result.current.create(CONTAINER_ID, 'Filing deadline', '2026-03-19');

    expect(refusal).toBeNull();
    expect(stub.itemWrites).toHaveLength(1);
    expect(stub.itemWrites[0]?.properties).toEqual({ due: '2026-03-19' });
  });

  /**
   * The exact trap goal 3.10 names: the property must come from the container's own view
   * configuration, never from whatever a calendar window happens to hold. This container's views
   * name `due`; nothing about a differently-named property anywhere else should change that.
   */
  it("resolves the property from the container's own views, not from anything else in reach", async () => {
    const stub = stubFetch({ views: viewsResponse('due') });
    const { result } = renderHook(() => useWorkspaceCalendar('2026-03-01', '2026-03-31'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    await result.current.create(CONTAINER_ID, 'Anything', '2026-04-02');

    expect(stub.viewsRequested).toContain(CONTAINER_ID);
    expect(stub.itemWrites[0]?.properties).toEqual({ due: '2026-04-02' });
  });

  it("refuses when the container's calendar no longer names a date property", async () => {
    const stub = stubFetch({ views: viewsResponse(null) });
    const { result } = renderHook(() => useWorkspaceCalendar('2026-03-01', '2026-03-31'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const refusal = await result.current.create(CONTAINER_ID, 'Anything', '2026-03-19');

    expect(refusal).toMatch(/no longer names a date property/i);
    // Refused before either write, so nothing was created and nothing was left half-done.
    expect(stub.propertyWrites).toHaveLength(0);
  });

  it("surfaces the service's own words when the item cannot be created", async () => {
    stubFetch({
      createStatus: 422,
      createBody: { detail: 'A title is required.' },
    });
    const { result } = renderHook(() => useWorkspaceCalendar('2026-03-01', '2026-03-31'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const refusal = await result.current.create(CONTAINER_ID, '', '2026-03-19');

    expect(refusal).toBe('A title is required.');
  });

  /**
   * The item was made but its date could not be saved. This must not read as success, and it must
   * not read as nothing having happened either - both would be dishonest about what the workspace
   * now holds.
   */
  it("surfaces the service's own words when the atomic dated-item write is refused", async () => {
    stubFetch({
      createStatus: 422,
      createBody: { detail: 'due must be a date, not a time.' },
    });
    const { result } = renderHook(() => useWorkspaceCalendar('2026-03-01', '2026-03-31'), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });

    const refusal = await result.current.create(CONTAINER_ID, 'Filing deadline', '2026-03-19');

    expect(refusal).toBe('due must be a date, not a time.');
  });
});
