import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, STUB_WORKSPACE, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';
import { useKnownSmartListsStore } from '../../views/query/known-smart-lists';

/**
 * The rail's Smart lists section (plan 1.8): every smart list this browser has opened, pin and unpin,
 * and "New smart list" - driven through the whole application, like the rail's own tests, because what
 * a link points at is only true in a router.
 */

const WORKSPACE = STUB_WORKSPACE.id;
const ROOT = `/w/${WORKSPACE}`;

const NOTE = item({ id: '1e1e1e1e-1111-4111-8111-1e1e1e1e1e1e', title: 'Acquisition memo' });

function rail(): HTMLElement {
  return screen.getByRole('navigation', { name: /destinations/i });
}

beforeEach(() => {
  signedIn();
  useKnownSmartListsStore.setState({
    known: {
      [WORKSPACE]: [
        { id: 'list-overdue', title: 'Overdue', pinned: false },
        { id: 'list-shop', title: 'Shopping', pinned: true },
      ],
    },
  });
});

describe('the rail Smart lists section', () => {
  it('shows a pinned smart list as a rail destination right after Smart lists', async () => {
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    const controls = within(rail())
      .getAllByRole('listitem')
      .map((entry) => within(entry).queryByRole('link')?.textContent ?? entry.textContent);
    const at = controls.indexOf('Smart lists');
    // The pinned list carries its initial before its name, so two pinned lists differ at a glance.
    expect(controls.slice(at, at + 2)).toEqual(['Smart lists', 'SShopping']);
    expect(within(rail()).getByRole('link', { name: 'Shopping' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-shop`,
    );
  });

  it('says first that the list is only what this browser opened, then lists them', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Smart lists' }));
    const menu = await screen.findByRole('menu', { name: 'Smart lists' });

    expect(within(menu).getAllByRole('menuitem')[0]).toHaveAccessibleName(
      'Smart lists opened in this browser',
    );
    expect(within(menu).getAllByRole('menuitem')[0]).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Overdue' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-overdue`,
    );
    expect(
      within(menu).getByRole('menuitem', { name: "Unpin Shopping from this browser's rail" }),
    ).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'New smart list' })).toHaveAttribute(
      'href',
      `${ROOT}/new/query`,
    );
  });

  it('pins a smart list into the rail from the menu', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Smart lists' }));
    await user.click(
      await screen.findByRole('menuitem', { name: "Pin Overdue to this browser's rail" }),
    );

    expect(await within(rail()).findByRole('link', { name: 'Overdue' })).toHaveAttribute(
      'href',
      `${ROOT}?item=list-overdue`,
    );
  });

  it('says when this browser has not opened any smart list yet', async () => {
    const user = userEvent.setup();
    useKnownSmartListsStore.setState({ known: {} });
    stubCoreApi({ items: [NOTE] });
    renderAt(<App />);
    await screen.findByRole('button', { name: 'Acquisition memo' });

    await user.click(within(rail()).getByRole('button', { name: 'Smart lists' }));

    expect(
      await screen.findByRole('menuitem', { name: 'Smart lists opened in this browser: none yet' }),
    ).toBeDisabled();
  });
});
