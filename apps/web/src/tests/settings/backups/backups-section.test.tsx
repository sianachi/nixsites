import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../app';
import { stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
});

afterEach(() => {
  vi.useRealTimers();
});

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

function run(
  step: 'local' | 'offsite',
  status: 'succeeded' | 'failed',
  hours: number,
  error: string | null = null,
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    startedAt: hoursAgo(hours + 0.1),
    finishedAt: hoursAgo(hours),
    step,
    status,
    snapshotId: null,
    bytes: status === 'succeeded' ? 2048 : null,
    error,
  };
}

describe('Settings > Backups', () => {
  it('is offered only to operators, and a deep link falls back to the default tab for anyone else', async () => {
    stubCoreApi({ operator: false });
    renderAt(<App />, '/settings?tab=backups');

    expect(await screen.findByRole('link', { name: 'MCP' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Backups' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('region', { name: 'Backups' })).not.toBeInTheDocument();
  });

  it('leads with the age of the last success and warns when a step is overdue', async () => {
    stubCoreApi({
      operator: true,
      backupRuns: [
        run('offsite', 'failed', 3, 'off-host push failed (exit 1)'),
        run('local', 'succeeded', 3),
        run('offsite', 'succeeded', 30),
      ],
    });
    renderAt(<App />, '/settings?tab=backups');

    const section = await screen.findByRole('region', { name: 'Backups' });
    const local = await within(section).findByRole('group', { name: 'Local' });
    expect(within(local).getByText('On schedule')).toBeVisible();
    const offsite = within(section).getByRole('group', { name: 'Off-site' });
    expect(within(offsite).getByText('Overdue')).toBeVisible();
    expect(within(offsite).getByText(/off-host push failed \(exit 1\)/)).toBeVisible();
  });

  it('says so when the loaded runs hold no success, and shows error text as text', async () => {
    stubCoreApi({
      operator: true,
      backupRuns: [
        run('local', 'failed', 2, '<b>local backup failed</b> (exit 1)'),
        run('offsite', 'failed', 2, 'off-host push failed (exit 1)'),
      ],
    });
    renderAt(<App />, '/settings?tab=backups');

    const local = await screen.findByRole('group', { name: 'Local' });
    expect(within(local).getByText('None in the last 1 run')).toBeVisible();
    expect(within(local).getByText(/<b>local backup failed<\/b> \(exit 1\)/)).toBeVisible();
    expect(within(local).queryByRole('strong')).not.toBeInTheDocument();
    expect(within(local).getByText('Overdue')).toBeVisible();
  });

  it('shows off-site as never, without a warning, when it has no rows, but still flags a local step with none', async () => {
    stubCoreApi({ operator: true, backupRuns: [run('local', 'succeeded', 3)] });
    const first = renderAt(<App />, '/settings?tab=backups');
    const offsite = await screen.findByRole('group', { name: 'Off-site' });
    expect(within(offsite).getByText('Never', { selector: 'span' })).toBeVisible();
    expect(within(offsite).getAllByText('Never')).toHaveLength(2);
    expect(within(offsite).queryByText('Overdue')).not.toBeInTheDocument();
    first.unmount();

    stubCoreApi({ operator: true, backupRuns: [run('offsite', 'succeeded', 3)] });
    renderAt(<App />, '/settings?tab=backups');
    const local = await screen.findByRole('group', { name: 'Local' });
    expect(within(local).getByText('Overdue')).toBeVisible();
    expect(within(local).getByText('Never')).toBeVisible();
  });

  it("counts only the step's own runs in the none-in-window sentence", async () => {
    stubCoreApi({
      operator: true,
      backupRuns: [
        run('local', 'failed', 5, 'local backup failed (exit 1)'),
        run('local', 'failed', 4, 'local backup failed (exit 1)'),
        run('local', 'failed', 3, 'local backup failed (exit 1)'),
        run('offsite', 'succeeded', 3),
        run('offsite', 'succeeded', 2),
      ],
    });
    renderAt(<App />, '/settings?tab=backups');

    const local = await screen.findByRole('group', { name: 'Local' });
    expect(within(local).getByText('None in the last 3 runs')).toBeVisible();
  });

  it('flips an open tab to overdue as time passes, without a reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
    stubCoreApi({
      operator: true,
      backupRuns: [run('local', 'succeeded', 25.9), run('offsite', 'succeeded', 25.9)],
    });
    renderAt(<App />, '/settings?tab=backups');

    const local = await screen.findByRole('group', { name: 'Local' });
    expect(within(local).getByText('On schedule')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(within(local).getByText('Overdue')).toBeVisible();
  });

  it('says plainly that nothing has been recorded, and that a refusal could not be loaded', async () => {
    stubCoreApi({ operator: true, backupRuns: [] });
    const first = renderAt(<App />, '/settings?tab=backups');
    expect(await screen.findByText('No backup has been recorded')).toBeVisible();
    first.unmount();

    stubCoreApi({ operator: true, backupsFail: true });
    renderAt(<App />, '/settings?tab=backups');
    expect(await screen.findByText('Backup status could not be loaded')).toBeVisible();
  });
});
