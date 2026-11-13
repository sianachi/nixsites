import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import { isoWeek } from '../../pages/homebase';
import { STUB_WORKSPACE, item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { memoryStorage } from '@nix/web-foundation/testing/memory-storage';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

const ROADMAP = item({ id: '3a3a3a3a-3333-4333-8333-3a3a3a3a3a3a', title: 'Roadmap' });
const HOME = `/w/${STUB_WORKSPACE.id}`;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  signedIn();
});

describe('Homebase', () => {
  it('greets, offers the start actions and lists what was opened last', async () => {
    stubCoreApi({ items: [ROADMAP] });
    renderAt(<App />, `${HOME}?item=${ROADMAP.id}`);
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Roadmap');
    await userEvent.click(screen.getByRole('link', { name: 'Homebase' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: /good (morning|afternoon|evening)/i }),
    ).toBeVisible();
    const start = screen.getByRole('region', { name: 'Start something' });
    expect(within(start).getByRole('button', { name: /new note/i })).toBeInTheDocument();
    expect(within(start).getByRole('button', { name: /continue.*roadmap/i })).toBeInTheDocument();
    expect(within(start).getByRole('link', { name: /today's note/i })).toHaveAttribute(
      'href',
      `${HOME}/daily`,
    );
    const more = screen.getByRole('region', { name: 'More' });
    expect(
      within(more).getByRole('button', { name: /new list, board or tracker/i }),
    ).toBeInTheDocument();
    expect(within(more).getByRole('link', { name: /calendar/i })).toHaveAttribute(
      'href',
      `${HOME}/calendar`,
    );
    expect(within(more).getByRole('link', { name: /templates/i })).toHaveAttribute(
      'href',
      `${HOME}/templates`,
    );
    expect(within(more).queryByRole('link', { name: /automations/i })).not.toBeInTheDocument();
    expect(within(more).getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      `${HOME}/settings`,
    );
    expect(screen.queryByRole('group', { name: 'Homebase layout' })).not.toBeInTheDocument();

    await userEvent.click(within(more).getByRole('button', { name: /^import/i }));
    expect(await screen.findByRole('dialog', { name: /import/i })).toBeVisible();

    await userEvent.click(within(start).getByRole('button', { name: /continue.*roadmap/i }));
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Roadmap');
  });

  it('leaves out the daily note where daily notes are off and invites a first note', async () => {
    stubCoreApi({ workspaces: [{ ...STUB_WORKSPACE, canUseDailyNotes: false }] });
    renderAt(<App />, HOME);

    const start = await screen.findByRole('region', { name: 'Start something' });
    expect(within(start).queryByRole('link', { name: /today's note/i })).not.toBeInTheDocument();
    expect(screen.getByText('Notes you open show up here.')).toBeVisible();
  });

  it('creates and opens a note, and offers the structured recipes', async () => {
    stubCoreApi();
    renderAt(<App />, HOME);

    const start = await screen.findByRole('region', { name: 'Start something' });
    const more = screen.getByRole('region', { name: 'More' });
    await userEvent.click(
      within(more).getByRole('button', { name: /new list, board or tracker/i }),
    );
    expect(await screen.findByRole('dialog', { name: 'New list, board or tracker' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    await userEvent.click(within(start).getByRole('button', { name: /new note/i }));
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled note');
    // Scoped to the undo bar: the opened note's toolbar has its own text Undo.
    const created = await screen.findByText('Created "Untitled note"');
    const bar = created.closest<HTMLElement>('[role="status"]');
    if (bar === null) throw new Error('The undo bar is missing.');
    expect(within(bar).getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  it('opens the existing Explorer and searches even unexpanded folders', async () => {
    const user = userEvent.setup();
    localStorage.setItem('nix.sidebar', 'collapsed');
    const projects = item({
      id: '4b4b4b4b-4444-4444-8444-4b4b4b4b4b4b',
      title: 'Projects',
      hasChildren: true,
    });
    const launch = item({
      id: '5c5c5c5c-5555-4555-8555-5c5c5c5c5c5c',
      title: 'Launch plan',
      parentId: projects.id,
    });
    const budget = item({
      id: '6d6d6d6d-6666-4666-8666-6d6d6d6d6d6d',
      title: 'Budget',
      parentId: projects.id,
    });
    stubCoreApi({ items: [ROADMAP, projects, launch, budget] });
    renderAt(<App />, HOME);

    const explore = await screen.findByRole('button', { name: 'Explore' });
    expect(screen.queryByRole('complementary', { name: 'Explorer' })).not.toBeInTheDocument();
    await user.click(explore);
    const explorer = within(await screen.findByRole('complementary', { name: 'Explorer' }));
    expect(explorer.getByRole('button', { name: 'Roadmap' })).toBeVisible();
    expect(explorer.queryByRole('button', { name: 'Launch plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Explore' })).not.toBeInTheDocument();

    const search = explorer.getByRole('searchbox', { name: 'Search Explorer' });
    await user.type(search, 'laun');
    const results = within(await explorer.findByRole('list', { name: 'Explorer search results' }));
    expect(results.queryByRole('button', { name: 'Budget' })).not.toBeInTheDocument();
    await user.click(results.getByRole('button', { name: 'Launch plan' }));
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Launch plan');
  });

  it('numbers weeks the ISO way', () => {
    expect(isoWeek(new Date(2026, 9, 28))).toBe(44);
    expect(isoWeek(new Date(2027, 0, 1))).toBe(53);
    expect(isoWeek(new Date(2026, 0, 1))).toBe(1);
  });

  it('opens the workspace list from the button at the top right', async () => {
    stubCoreApi();
    renderAt(<App />, HOME);

    await userEvent.click(await screen.findByRole('button', { name: 'Workspaces' }));

    expect(await screen.findByRole('dialog', { name: 'Workspaces' })).toBeVisible();
  });
});
