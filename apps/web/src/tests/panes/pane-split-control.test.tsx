import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSearchParams } from 'react-router';

import { App } from '../../app';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const FIRST = item({ id: '91919191-1111-4111-8111-919191919191', title: 'First note' });
const SECOND = item({ id: '92929292-2222-4222-8222-929292929292', title: 'Second note' });

beforeEach(() => {
  signedIn();
  stubViewport(true);
});

function SearchState() {
  const [searchParams] = useSearchParams();
  return <output aria-label="Current search">{searchParams.toString()}</output>;
}

describe('choosing how panes are split', () => {
  it('switches between side-by-side and stacked panes without losing their ratio', async () => {
    stubCoreApi({ items: [FIRST, SECOND] });
    const user = userEvent.setup();
    renderAt(
      <>
        <App />
        <SearchState />
      </>,
      `/?item=${FIRST.id}&item2=${SECOND.id}&sizes=60,40&keep=present`,
    );

    const control = await screen.findByRole('group', { name: 'Pane layout' });
    await screen.findByDisplayValue('First note');
    await screen.findByDisplayValue('Second note');
    const sideBySide = screen.getByRole('button', { name: 'Side by side' });
    const stacked = screen.getByRole('button', { name: 'Stacked' });
    const paneDivider = () =>
      screen.getByRole('separator', { name: 'Resize First note and Second note' });
    expect(control).toContainElement(sideBySide);
    expect(sideBySide).toHaveAttribute('aria-current', 'true');
    expect(paneDivider()).toHaveAttribute('aria-orientation', 'vertical');
    expect(paneDivider()).toHaveAttribute('aria-valuenow', '60');

    stacked.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(stacked).toHaveAttribute('aria-current', 'true');
      expect(paneDivider()).toHaveAttribute('aria-orientation', 'horizontal');
    });
    expect(stacked).toHaveFocus();
    expect(sideBySide).not.toHaveAttribute('aria-current');
    expect(paneDivider()).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByRole('status', { name: 'Current search' })).toHaveTextContent(
      `item=${FIRST.id}&item2=${SECOND.id}&sizes=60%2C40&keep=present&split=h`,
    );
    expect(screen.getAllByRole('textbox', { name: /note title/i })).toHaveLength(2);

    await user.click(sideBySide);

    await waitFor(() => {
      expect(sideBySide).toHaveAttribute('aria-current', 'true');
      expect(paneDivider()).toHaveAttribute('aria-orientation', 'vertical');
    });
    expect(screen.getByRole('status', { name: 'Current search' })).toHaveTextContent('split=v');
  });

  it('does not spend space on a split choice until more than one pane is visible', async () => {
    stubCoreApi({ items: [FIRST] });
    renderAt(<App />, `/?item=${FIRST.id}`);

    expect(await screen.findByRole('textbox', { name: /note title/i })).toHaveValue('First note');
    expect(screen.queryByRole('group', { name: 'Pane layout' })).not.toBeInTheDocument();
  });

  it('does not offer an inert layout choice when a narrow window hides addressed panes', async () => {
    stubViewport(false);
    stubCoreApi({ items: [FIRST, SECOND] });
    renderAt(<App />, `/?item=${FIRST.id}&item2=${SECOND.id}`);

    expect(
      await screen.findByText('One more pane in this link opens on a wider screen.'),
    ).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Pane layout' })).not.toBeInTheDocument();
  });
});
