import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { signedIn } from '../render-with-router';
import { requestUrl } from '../request-url';

const SHARED: StubWorkspace = {
  ...STUB_WORKSPACE,
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Shared research',
  kind: 'shared',
  canLeave: true,
  canUseDailyNotes: false,
};

beforeEach(() => {
  signedIn();
});

describe('workspace binding under StrictMode', () => {
  it.each([
    ['items', '', (path: string) => path.endsWith('/items'), true],
    ['calendar', '/calendar', (path: string) => path.endsWith('/calendar'), true],
    ['graph', '/graph', (path: string) => path.endsWith('/graph'), true],
    ['Daily notes', '/daily/2026-08-30', (path: string) => path.includes('/daily-notes/'), false],
  ] as const)(
    'aborts the deferred %s request from workspace A before workspace B can answer',
    async (_label, suffix, matchesResource, requestsInSharedWorkspace) => {
      stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
      const fallbackFetch = fetch;
      const aSignals: AbortSignal[] = [];
      let bRequests = 0;
      let navigate: NavigateFunction = () => Promise.resolve();
      vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : null;
          const url = requestUrl(input);
          const path = new URL(url, location.origin).pathname;
          const signal = init?.signal ?? request?.signal;
          if (path.includes(`/workspaces/${STUB_WORKSPACE.id}/`) && matchesResource(path)) {
            if (signal === undefined) {
              throw new Error('A workspace resource request must be cancellable.');
            }
            aSignals.push(signal);
            if (signal.aborted) {
              return Promise.reject(new DOMException('The request was aborted.', 'AbortError'));
            }
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  reject(new DOMException('The request was aborted.', 'AbortError'));
                },
                { once: true },
              );
            });
          }
          if (path.includes(`/workspaces/${SHARED.id}/`) && matchesResource(path)) bRequests += 1;
          return fallbackFetch(input, init);
        }),
      );

      render(
        <StrictMode>
          <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}${suffix}`]}>
            <NavigationDriver
              ready={(value) => {
                navigate = value;
              }}
            />
            <App />
          </MemoryRouter>
        </StrictMode>,
      );

      await waitFor(() => {
        expect(aSignals.some((signal) => !signal.aborted)).toBe(true);
      });
      const activeA = aSignals.findLast((signal) => !signal.aborted);
      expect(activeA).toBeDefined();

      void navigate(`/w/${SHARED.id}${suffix}`);

      await waitFor(() => {
        expect(activeA?.aborted).toBe(true);
      });
      if (requestsInSharedWorkspace) {
        expect(bRequests).toBeGreaterThan(0);
      } else {
        expect(bRequests).toBe(0);
      }
    },
  );

  it('loads a template catalog once across rerenders and once again for a workspace switch', async () => {
    const user = userEvent.setup();
    stubCoreApi({ workspaces: [STUB_WORKSPACE, SHARED] });
    const fallbackFetch = fetch;
    const counts = new Map<string, number>();
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestUrl(input);
        const match = /\/api\/v1\/workspaces\/([0-9a-f-]{36})\/templates$/.exec(
          new URL(url, location.origin).pathname,
        );
        if (match?.[1] !== undefined) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
        return fallbackFetch(input, init);
      }),
    );
    const app = (
      <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}/templates`]}>
        <App />
      </MemoryRouter>
    );
    const rendered = render(app);

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    await waitFor(() => {
      expect(counts.get(STUB_WORKSPACE.id)).toBe(1);
    });
    rendered.rerender(app);
    await waitFor(() => {
      expect(counts.get(STUB_WORKSPACE.id)).toBe(1);
    });

    await user.click(screen.getByRole('button', { name: 'Workspace menu' }));
    await user.click(
      within(screen.getByRole('region', { name: 'Workspaces' })).getByRole('link', {
        name: SHARED.name,
      }),
    );
    await waitFor(() => {
      expect(counts.get(SHARED.id)).toBe(1);
    });
  });
});

function NavigationDriver({
  ready,
}: {
  readonly ready: (navigate: NavigateFunction) => void;
}): ReactNode {
  const navigate = useNavigate();
  useEffect(() => {
    ready(navigate);
  }, [navigate, ready]);
  return null;
}
