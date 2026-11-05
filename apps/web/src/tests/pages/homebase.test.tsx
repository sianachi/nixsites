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
    expect(within(start).getByRole('button', { name: /structured note/i })).toBeInTheDocument();
    expect(within(start).getByRole('link', { name: /today's note/i })).toHaveAttribute(
      'href',
      `${HOME}/daily`,
    );
    expect(within(start).getByRole('link', { name: /calendar/i })).toHaveAttribute(
      'href',
      `${HOME}/calendar`,
    );
    expect(within(start).getByRole('link', { name: /templates/i })).toHaveAttribute(
      'href',
      `${HOME}/templates`,
    );
    expect(within(start).getByRole('link', { name: /automations/i })).toHaveAttribute(
      'href',
      `${HOME}/automations`,
    );
    expect(within(start).getByRole('link', { name: /settings/i })).toHaveAttribute(
      'href',
      `${HOME}/settings`,
    );
    expect(screen.queryByRole('group', { name: 'Homebase layout' })).not.toBeInTheDocument();

    await userEvent.click(within(start).getByRole('button', { name: /^import/i }));
    expect(await screen.findByRole('dialog', { name: /import/i })).toBeVisible();

    const recent = screen.getByRole('region', { name: 'Recently viewed' });
    await userEvent.click(within(recent).getByRole('button', { name: /roadmap/i }));
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
    await userEvent.click(within(start).getByRole('button', { name: /structured note/i }));
    expect(await screen.findByRole('dialog', { name: 'New structured item' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));

    await userEvent.click(within(start).getByRole('button', { name: /new note/i }));
    expect(await screen.findByRole('textbox', { name: 'Note title' })).toHaveValue('Untitled note');
  });

  it('explores the files: into a folder, back up the path, filtered, and open', async () => {
    const user = userEvent.setup();
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

    await user.click(await screen.findByRole('button', { name: 'Explore' }));
    const dialog = await screen.findByRole('dialog', { name: 'Explore' });
    const top = within(dialog).getByRole('list', { name: 'All items' });
    expect(await within(top).findByRole('button', { name: 'Roadmap' })).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Browse Projects' }));
    const inside = await within(dialog).findByRole('list', { name: 'Items in Projects' });
    expect(await within(inside).findByRole('button', { name: 'Launch plan' })).toBeVisible();
    expect(within(inside).getByRole('button', { name: 'Budget' })).toBeVisible();

    await user.type(within(dialog).getByRole('searchbox', { name: 'Filter Projects' }), 'laun');
    expect(within(inside).queryByRole('button', { name: 'Budget' })).not.toBeInTheDocument();

    const path = within(dialog).getByRole('navigation', { name: 'Folder path' });
    await user.click(within(path).getByRole('button', { name: 'All items' }));
    expect(within(dialog).getByRole('list', { name: 'All items' })).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Browse Projects' }));

    await user.click(await within(dialog).findByRole('button', { name: 'Launch plan' }));
    expect(screen.queryByRole('dialog', { name: 'Explore' })).not.toBeInTheDocument();
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
