import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi, type StubWorkspace } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

/**
 * The per-workspace daily-notes switch, and every entry point that has to respect it.
 *
 * Driven through the whole application, because the switch is one flag on the accessible
 * workspace list and the promise is that every place reading it agrees - including right after
 * the switch is flipped, without a reload.
 */

const OFF: StubWorkspace = { ...STUB_WORKSPACE, canUseDailyNotes: false };

const NOTE = item({
  id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e',
  title: 'Acquisition memo',
});

const DAILY = item({
  id: '2d2d2d2d-2222-4222-8222-2d2d2d2d2d2d',
  title: '2026-08-30',
  properties: { title: '2026-08-30', $daily: '2026-08-30' },
});

beforeEach(() => {
  signedIn();
});

afterEach(() => {
  vi.useRealTimers();
});

function Where() {
  const location = useLocation();
  return <output aria-label="Location">{`${location.pathname}${location.search}`}</output>;
}

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

/** Lets pending requests settle, so an absence is asserted after the thing could have appeared. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('the command palette', () => {
  async function paletteFor(query: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^search/i }));
    await user.type(screen.getByRole('combobox', { name: /search items/i }), query);
    return screen.getByRole('dialog', { name: /search/i });
  }

  it('offers today’s note while daily notes are on', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);

    const dialog = await paletteFor('note');
    expect(await within(dialog).findByRole('option', { name: /Open today’s note/ })).toBeVisible();
  });

  it('leaves today’s note out while daily notes are off', async () => {
    stubCoreApi({ workspaces: [OFF], items: [NOTE] });
    renderAt(<App />);

    const dialog = await paletteFor('note');
    expect(await within(dialog).findByRole('option', { name: /New note/ })).toBeVisible();
    expect(within(dialog).queryByRole('option', { name: /Open today’s note/ })).toBeNull();
    expect(within(dialog).queryByRole('option', { name: /Capture to today’s note/ })).toBeNull();
  });
});

describe('the Today launch shortcut', () => {
  it('lands on the workspace and says why when daily notes are off', async () => {
    stubCoreApi({ workspaces: [OFF], items: [NOTE] });
    renderAt(
      <>
        <App />
        <Where />
      </>,
      '/launch/today',
    );

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe(`/w/${OFF.id}`);
    });
    // Shown as a toast and said through the shell's live region, so the words are there twice.
    expect(
      await screen.findAllByText(`Daily notes are switched off in ${OFF.name}.`),
    ).not.toHaveLength(0);

    // The one who may switch them on is offered the way there.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Location' }).textContent).toBe(
        `/w/${OFF.id}/settings?tab=daily-notes`,
      );
    });
  });

  it('offers no way to switch them on to someone who may not', async () => {
    stubCoreApi({ workspaces: [{ ...OFF, canRename: false }], items: [NOTE] });
    renderAt(<App />, '/launch/today');

    // Shown as a toast and said through the shell's live region, so the words are there twice.
    expect(
      await screen.findAllByText(`Daily notes are switched off in ${OFF.name}.`),
    ).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Turn on' })).toBeNull();
  });
});

describe('the daily note bar', () => {
  it('shows on a daily note while daily notes are on', async () => {
    stubCoreApi({ items: [DAILY] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}?item=${DAILY.id}`);

    const bar = await screen.findByRole('region', { name: 'Daily note' });
    expect(within(bar).getByRole('button', { name: 'Previous day' })).toBeInTheDocument();
  });

  it('is absent while daily notes are off, and the note still opens', async () => {
    stubCoreApi({ workspaces: [OFF], items: [DAILY] });
    renderAt(<App />, `/w/${OFF.id}?item=${DAILY.id}`);

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('2026-08-30');
    await settle();
    expect(screen.queryByRole('region', { name: 'Daily note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous day' })).toBeNull();
  });
});

describe('the calendar', () => {
  const ENTRIES = [
    {
      itemId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      title: 'Filing deadline',
      containerId: 'cccccccc-3333-4333-8333-cccccccccccc',
      containerTitle: 'Deadlines',
      dateProperty: 'due',
      value: '2026-03-12',
      kind: 'date' as const,
    },
    {
      itemId: DAILY.id,
      title: '2026-03-17',
      containerId: 'dddddddd-4444-4444-8444-dddddddddddd',
      containerTitle: 'Daily notes',
      dateProperty: '$daily',
      value: '2026-03-17',
      kind: 'date' as const,
    },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 2, 17, 12, 0, 0));
  });

  it('draws daily notes while they are on', async () => {
    stubCoreApi({ calendarEntries: ENTRIES });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/calendar`);

    expect(await screen.findByRole('button', { name: /^Filing deadline/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2026-03-17, in Daily notes' })).toBeInTheDocument();
  });

  it('leaves daily notes off while they are off, even if the read sends them', async () => {
    stubCoreApi({ workspaces: [OFF], calendarEntries: ENTRIES });
    renderAt(<App />, `/w/${OFF.id}/calendar`);

    expect(await screen.findByRole('button', { name: /^Filing deadline/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2026-03-17, in Daily notes' })).toBeNull();
  });
});

describe('switching daily notes on and off', () => {
  it('updates the rail as soon as the Daily notes tab saves, without a reload', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/settings?tab=daily-notes`);

    const enabled = await screen.findByRole('checkbox', {
      name: 'Use daily notes in this workspace',
    });
    expect(within(rail()).getByRole('link', { name: 'Daily notes' })).toBeInTheDocument();

    await user.click(enabled);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(within(rail()).queryByRole('link', { name: 'Daily notes' })).toBeNull();
    });
    expect(writes.dailyNoteSettingsWrites.at(-1)?.settings.enabled).toBe(false);

    await user.click(enabled);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(rail()).findByRole('link', { name: 'Daily notes' })).toBeInTheDocument();
  });

  it('offers the switch in the Workspace tab, through the same save', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/settings`);

    const enabled = await screen.findByRole('checkbox', { name: 'Daily notes' });
    expect(enabled).toBeChecked();
    expect(screen.getByRole('link', { name: /Daily notes settings/ })).toHaveAttribute(
      'href',
      `/w/${STUB_WORKSPACE.id}/settings?tab=daily-notes`,
    );

    await user.click(enabled);
    expect(await screen.findAllByText('Daily notes are off for this workspace.')).not.toHaveLength(
      0,
    );
    expect(writes.dailyNoteSettingsWrites).toEqual([
      {
        workspaceId: STUB_WORKSPACE.id,
        settings: {
          enabled: false,
          folders: 'flat',
          titleFormat: 'iso',
          template: '',
          rolloverHour: 0,
          showOnCalendar: true,
        },
      },
    ]);
    await waitFor(() => {
      expect(within(rail()).queryByRole('link', { name: 'Daily notes' })).toBeNull();
    });

    await user.click(enabled);
    expect(await screen.findAllByText('Daily notes are on for this workspace.')).not.toHaveLength(
      0,
    );
    expect(await within(rail()).findByRole('link', { name: 'Daily notes' })).toBeInTheDocument();
  });

  it('shows the switch read-only to someone who may not change it', async () => {
    const writes = stubCoreApi({
      workspaces: [{ ...STUB_WORKSPACE, canRename: false, canManageMembers: false }],
      items: [NOTE],
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/settings`);

    const enabled = await screen.findByRole('checkbox', { name: 'Daily notes' });
    expect(enabled).toBeDisabled();
    expect(
      screen.getByText('Only a workspace owner or an administrator can change these.'),
    ).toBeVisible();
    expect(writes.dailyNoteSettingsWrites).toEqual([]);
  });
});

describe('opening a daily note that cannot be opened', () => {
  it('says the day’s note is in Trash, keeps the server’s words, and links to Trash', async () => {
    const detail = 'This day’s note is in Trash. Restore it from Trash to open it.';
    stubCoreApi({
      dailyNoteOpenFails: { status: 409, code: 'workspaces.daily_note_in_trash', detail },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-08-30`);

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(screen.getByRole('link', { name: 'Open Trash' })).toHaveAttribute(
      'href',
      `/w/${STUB_WORKSPACE.id}/trash`,
    );
  });

  it('says the day’s note is locked, without a Trash link', async () => {
    const detail = 'This day’s note is locked. Unlock it before opening it.';
    stubCoreApi({
      dailyNoteOpenFails: { status: 423, code: 'workspaces.daily_note_locked', detail },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-08-30`);

    expect(await screen.findByRole('alert')).toHaveTextContent(detail);
    expect(screen.queryByRole('link', { name: 'Open Trash' })).toBeNull();
  });

  it('falls back to its own words when the server sends none', async () => {
    stubCoreApi({
      dailyNoteOpenFails: { status: 409, code: 'workspaces.daily_note_locked' },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-08-30`);

    expect(await screen.findByRole('alert')).toHaveTextContent(/locked\. Unlock it/);
  });

  it('does not claim the workspace on screen is missing', async () => {
    stubCoreApi({
      dailyNoteOpenFails: {
        status: 404,
        code: 'workspaces.not_found',
        detail: 'No accessible workspace has that identifier.',
      },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/daily/2026-08-30`);

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/No accessible workspace/);
    expect(alert).toHaveTextContent(/cannot create or open daily notes in this workspace/);
  });
});
