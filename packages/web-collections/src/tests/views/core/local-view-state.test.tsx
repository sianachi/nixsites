import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it } from 'vitest';
import { LocalViewStateContext, useViewState } from '../../../core/view-state';

function DialogView() {
  const view = useViewState();
  return (
    <>
      <button
        onClick={() => {
          view.setFilter('status', ['Done']);
        }}
      >
        Filter dialog: {view.filters[0]?.values[0] ?? 'none'}
      </button>
      <button
        onClick={() => {
          view.setSearch('Dialog note');
        }}
      >
        Search dialog: {view.search || 'none'}
      </button>
    </>
  );
}
function Parent() {
  const [params, setParams] = useState(() => new URLSearchParams());
  const location = useLocation();
  return (
    <>
      <output aria-label="Parent address">{location.search}</output>
      <LocalViewStateContext value={{ params, setParams }}>
        <DialogView />
      </LocalViewStateContext>
    </>
  );
}
it('keeps dialog filters out of the underlying view address', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/?view=board&sort=title&f.status=Doing']}>
      <Parent />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Filter dialog: none' }));
  expect(screen.getByRole('button', { name: 'Filter dialog: Done' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Parent address' })).toHaveTextContent(
    '?view=board&sort=title&f.status=Doing',
  );
});
it('keeps dialog title search out of the underlying pane address', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/?view=board&search=parent']}>
      <Parent />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('button', { name: 'Search dialog: none' }));
  expect(screen.getByRole('button', { name: 'Search dialog: Dialog note' })).toBeInTheDocument();
  expect(screen.getByRole('status', { name: 'Parent address' })).toHaveTextContent(
    '?view=board&search=parent',
  );
});
