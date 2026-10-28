import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { localDailyNoteDate, parseDailyNoteDate } from '../../daily-notes/daily-note';
import { STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';
import { requestUrl } from '../request-url';

beforeEach(() => {
  signedIn();
});

describe('daily notes', () => {
  it('uses the local calendar date in the familiar daily-note format', () => {
    expect(localDailyNoteDate(new Date(2026, 0, 5, 23, 30, 0))).toBe('2026-01-05');
    expect(parseDailyNoteDate('2026-02-29')).toBeNull();
    expect(parseDailyNoteDate('2028-02-29')).toBe('2028-02-29');
  });

  it('opens a dated note through the idempotent workspace operation', async () => {
    stubCoreApi();
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-08-30`);

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: '2026-08-30' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    const calls = vi.mocked(fetch).mock.calls.map(([input, init]) => ({
      url: requestUrl(input),
      method: init?.method ?? 'GET',
    }));
    expect(
      calls.filter(
        (call) =>
          call.method === 'PUT' &&
          call.url.includes(`/workspaces/${STUB_WORKSPACE.id}/daily-notes/2026-08-30`),
      ),
    ).toHaveLength(1);
  });

  it("canonicalizes today's route before calling Core", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 7, 30, 9, 0, 0));
    try {
      stubCoreApi();
      renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily`);

      await waitFor(() => {
        expect(
          vi
            .mocked(fetch)
            .mock.calls.some(
              ([input, init]) =>
                requestUrl(input).includes('/daily-notes/2026-08-30') && init?.method === 'PUT',
            ),
        ).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses malformed calendar dates without sending a create operation', async () => {
    stubCoreApi();
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-02-29`);

    expect(await screen.findByRole('heading', { name: 'Daily note not found' })).toBeVisible();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => requestUrl(input).includes('/daily-notes/')),
    ).toBe(false);
  });

  it('redirects a shared-workspace daily URL without calling Core', async () => {
    const shared: StubWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Shared research',
      kind: 'shared',
      canUseDailyNotes: false,
    };
    stubCoreApi({ workspaces: [STUB_WORKSPACE, shared] });
    renderAt(<App />, `/w/${shared.id}/daily/2026-08-30`);

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Homebase' })).toHaveAttribute(
        'href',
        `/w/${shared.id}`,
      );
    });
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => requestUrl(input).includes('/daily-notes/')),
    ).toBe(false);
  });
});
