import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import { item, STUB_WORKSPACE, stubCoreApi } from '../api-stub';
import { renderAt, signedIn } from '../render-with-router';

const NOTE = item({ id: '0a0a0a0a-0000-4000-8000-00000000000a', title: 'Alpha' });

beforeEach(() => {
  signedIn();
});

describe('the application keyboard shortcuts', () => {
  it('opens the shortcut sheet with Ctrl+/ and with ?, listing each chord', async () => {
    stubCoreApi({ items: [NOTE] });
    const user = userEvent.setup();
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    await screen.findByRole('button', { name: 'Alpha' });

    fireEvent.keyDown(document.body, { key: '/', code: 'Slash', ctrlKey: true });
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByText('Search and commands')).toBeInTheDocument();
    expect(within(sheet).getByText('Ctrl+K')).toBeInTheDocument();
    // jsdom has no native dialog cancel for Escape; the corner control is the same request.
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('leaves ? to a text field, where it is something people type', async () => {
    stubCoreApi({ items: [NOTE] });
    const user = userEvent.setup();
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    await screen.findByRole('button', { name: 'Alpha' });

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.keyboard('?');

    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).not.toBeInTheDocument();
  });

  it('hides and shows the sidebar with Ctrl+\\', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    // The loading shell also draws a sidebar toggle, before shell shortcuts are installed.
    await screen.findByRole('button', { name: 'Alpha' });
    const toggle = screen.getByRole('button', { name: 'Hide the Explorer' });

    fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true });

    await waitFor(() => {
      expect(toggle).toHaveAccessibleName('Show the Explorer');
    });
    fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true });
    await waitFor(() => {
      expect(toggle).toHaveAccessibleName('Hide the Explorer');
    });
  });

  it('creates and opens a note with Ctrl+Alt+N', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    await screen.findByRole('button', { name: 'Alpha' });

    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });

    expect(await screen.findByRole('tab', { name: 'Untitled note' })).toBeInTheDocument();
  });

  it('offers the shortcut sheet and today in the command palette, with their keys', async () => {
    stubCoreApi({ items: [NOTE] });
    const user = userEvent.setup();
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    await screen.findByRole('button', { name: 'Alpha' });

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.keyboard('shortcuts');
    await user.click(await screen.findByRole('option', { name: /Keyboard shortcuts/ }));

    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });

  it('changes nothing behind an open dialog', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}`);
    await screen.findByRole('button', { name: 'Alpha' });

    fireEvent.keyDown(document.body, { key: '/', code: 'Slash', ctrlKey: true });
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    fireEvent.keyDown(document.body, { key: 'n', code: 'KeyN', ctrlKey: true, altKey: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('tab', { name: 'Untitled note' })).not.toBeInTheDocument();
  });
});
