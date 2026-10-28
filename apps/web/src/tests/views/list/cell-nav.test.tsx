import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderAt } from '../../render-with-router';
import type { PropertyDefinition } from '../../../views/core/container-model';
import { ListView } from '../../../views/list/list-view';
import { aContainer } from '../../container-fixture';
import type { ContainerData } from '../../../views/core/use-container';
import { item, schemaOf } from '../../view-fixture';

/**
 * Alt+Arrow cell-to-cell movement (`../../../views/list/cell-nav.ts`), driven the way a keyboard
 * user drives it: focus a control, hold Alt, press an arrow.
 *
 * The one test that matters most here is the one that proves the design rather than the feature -
 * "a plain ArrowLeft moves the caret, not the cell". Everything else can be right and that one
 * thing wrong, and the whole point of gating this behind Alt is lost.
 */

function property(
  key: string,
  label: string,
  type: string,
  options: readonly string[] = [],
): PropertyDefinition {
  return { key, label, type, options: [...options], required: false };
}

function containerData(overrides: Partial<ContainerData> = {}): ContainerData {
  return aContainer(overrides);
}

const ZETA = item('item-z', 'Zeta', 1, { owner: 'Ada', status: 'open', done: false });
const ALPHA = item('item-a', 'Alpha', 2, { owner: 'Grace', status: 'closed', done: true });

/** The four-column list every direction/edge test moves around in. */
function renderFourColumnList(): void {
  renderAt(
    <ListView
      container={containerData({
        schema: schemaOf(
          property('owner', 'Owner', 'text'),
          property('status', 'Status', 'select'),
          property('done', 'Done', 'checkbox'),
        ),
        children: [ZETA, ALPHA],
      })}
      view={null}
      onOpen={vi.fn()}
    />,
  );
}

async function altArrow(
  user: ReturnType<typeof userEvent.setup>,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): Promise<void> {
  await user.keyboard(`{Alt>}{${key}}{/Alt}`);
}

describe('list cell navigation', () => {
  it('moves the focused cell right and left within a row on Alt+Arrow', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    await user.click(screen.getByRole('textbox', { name: 'Owner for Zeta' }));
    await altArrow(user, 'ArrowRight');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Status for Zeta' }));

    await altArrow(user, 'ArrowLeft');
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Owner for Zeta' }));
  });

  it('moves the focused cell down and up within a column on Alt+Arrow', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    await user.click(screen.getByRole('checkbox', { name: 'Done for Zeta' }));
    await altArrow(user, 'ArrowDown');
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Done for Alpha' }));

    await altArrow(user, 'ArrowUp');
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Done for Zeta' }));
  });

  it('stops at the first column rather than leaving the row on Alt+ArrowLeft', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const title = screen.getByRole('button', { name: 'Zeta' });
    await user.click(title);
    await altArrow(user, 'ArrowLeft');

    expect(document.activeElement).toBe(title);
  });

  it('stops at the last column rather than wrapping on Alt+ArrowRight', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const done = screen.getByRole('checkbox', { name: 'Done for Zeta' });
    await user.click(done);
    await altArrow(user, 'ArrowRight');

    expect(document.activeElement).toBe(done);
  });

  it('stops at the first row rather than leaving the table on Alt+ArrowUp', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const owner = screen.getByRole('textbox', { name: 'Owner for Zeta' });
    await user.click(owner);
    await altArrow(user, 'ArrowUp');

    expect(document.activeElement).toBe(owner);
  });

  it('stops at the last row rather than wrapping on Alt+ArrowDown', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const owner = screen.getByRole('textbox', { name: 'Owner for Alpha' });
    await user.click(owner);
    await altArrow(user, 'ArrowDown');

    expect(document.activeElement).toBe(owner);
  });

  it('sends the focused cell to the first column of its row on Alt+Home', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    await user.click(screen.getByRole('checkbox', { name: 'Done for Alpha' }));
    await altArrow(user, 'Home');

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Alpha' }));
  });

  it('sends the focused cell to the last column of its row on Alt+End', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    await user.click(screen.getByRole('button', { name: 'Zeta' }));
    await altArrow(user, 'End');

    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Done for Zeta' }));
  });

  it('leaves the caret alone on a plain ArrowLeft instead of moving the cell', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const owner = screen.getByRole('textbox', { name: 'Owner for Zeta' });
    await user.click(owner);
    await user.keyboard('{ArrowLeft}');

    // The assertion that protects the whole design: an un-modified arrow belongs to the field's own
    // caret, not to this feature, so focus must still be on the field it started on.
    expect(document.activeElement).toBe(owner);
  });

  it('leaves a plain Home and End to the field instead of moving the cell', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const owner = screen.getByRole('textbox', { name: 'Owner for Zeta' });
    await user.click(owner);
    await user.keyboard('{Home}{End}');

    expect(document.activeElement).toBe(owner);
  });

  it('lands on the trigger moving into a multi-select cell, and leaves from it', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('tags', 'Tags', 'multi_select', ['Urgent', 'Blocked'])),
          children: [ZETA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    const title = screen.getByRole('button', { name: 'Zeta' });
    await user.click(title);
    await altArrow(user, 'ArrowRight');

    // The cell is one line that opens its checkboxes in a popover, so the trigger is its control.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Tags for Zeta/ }));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    await altArrow(user, 'ArrowLeft');

    expect(document.activeElement).toBe(title);
  });

  it('lands on a real control moving into a timestamp cell, and leaves from it', async () => {
    const user = userEvent.setup();
    renderAt(
      <ListView
        container={containerData({
          schema: schemaOf(property('scheduled', 'Scheduled', 'timestamp')),
          children: [ZETA],
        })}
        view={null}
        onOpen={vi.fn()}
      />,
    );

    const title = screen.getByRole('button', { name: 'Zeta' });
    await user.click(title);
    await altArrow(user, 'ArrowRight');

    // A cell carries the moment alone; the zone is edited in the panel.
    expect(document.activeElement).toBe(screen.getByLabelText('Scheduled for Zeta'));
    expect(screen.queryByRole('combobox', { name: /Time zone/ })).toBeNull();

    await altArrow(user, 'ArrowLeft');

    expect(document.activeElement).toBe(title);
  });

  it('does not claim Alt+Arrow pressed on the sort header', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    const header = screen.getByRole('button', { name: 'Title' });
    await user.click(header);
    await altArrow(user, 'ArrowRight');

    // Not one of the list's own cells: the shortcut is left alone rather than claimed.
    expect(document.activeElement).toBe(header);
  });

  it('leaves the tab order untouched', async () => {
    const user = userEvent.setup();
    renderFourColumnList();

    screen.getByRole('button', { name: 'Zeta' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zeta' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Owner for Zeta' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Status for Zeta' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Done for Zeta' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Alpha' }));
  });
});
