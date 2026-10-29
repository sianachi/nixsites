import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';
import { requestUrl } from '@nix/web-foundation/testing/request-url';

const daily = item({
  id: '2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d',
  title: 'Daily writing',
  properties: { $daily: '2026-08-30' },
});

function requestUrls(): string[] {
  return vi.mocked(fetch).mock.calls.map(([input]) => requestUrl(input));
}

beforeEach(() => {
  signedIn();
});

it.each([280, 320, 360, 390, 430])(
  'keeps day controls and schedule behind a disclosure at width %i',
  async (width) => {
    stubViewport(width);
    stubCoreApi({ items: [daily] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}?item=${daily.id}`);
    const bar = await screen.findByRole('region', { name: 'Daily note' });
    expect(within(bar).queryByRole('button', { name: 'Previous day' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Go to a day')).not.toBeInTheDocument();
    expect(requestUrls().some((url) => url.includes('/calendar?'))).toBe(false);
    await userEvent.click(within(bar).getByRole('button', { name: /Day navigation/ }));
    const navigation = screen.getByRole('dialog', { name: 'Day navigation' });
    expect(within(navigation).getByLabelText('Go to a day')).toHaveValue('2026-08-30');
    await waitFor(() => {
      expect(requestUrls().some((url) => url.includes('/calendar?'))).toBe(true);
    });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Next day' }));
    await waitFor(() => {
      expect(requestUrls().some((url) => url.includes('/daily-notes/2026-08-31'))).toBe(true);
    });
    expect(screen.queryByRole('dialog', { name: 'Day navigation' })).not.toBeInTheDocument();
  },
);

it('reclaims the day strip when a zoomed writing viewport has a keyboard', async () => {
  stubViewport(390);
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('visualViewport', viewport);
  stubCoreApi({ items: [daily] });
  renderAt(<App />, `/w/${STUB_WORKSPACE.id}?item=${daily.id}`);
  await screen.findByRole('region', { name: 'Daily note' });
  act(() => {
    screen.getByRole('textbox', { name: 'Note title' }).focus();
    viewport.height = 400;
    viewport.scale = 1.25;
    viewport.dispatchEvent(new Event('resize'));
  });
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Daily note' })).not.toBeInTheDocument();
  });
  act(() => {
    viewport.height = 844 / 1.25;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(await screen.findByRole('region', { name: 'Daily note' })).toBeVisible();
});
