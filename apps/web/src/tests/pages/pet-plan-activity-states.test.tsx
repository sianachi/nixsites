import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { PetActivityPage } from '../../pages/pet-activity-page';

const state = vi.hoisted(() => ({ status: 'loading', retry: vi.fn() }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '8d849a57-bd08-487d-af5b-e0f69ac836a4' }),
}));
vi.mock('../../panel/use-pet-run-feed', () => ({
  usePetRunFeed: () => ({
    feed: { status: 'ready', data: { enabled: true, runs: [] } },
    retry: vi.fn(),
  }),
}));
vi.mock('../../panel/use-pet-plan-feed', () => ({
  usePetPlanFeed: () => ({ feed: { status: state.status }, retry: state.retry }),
}));

it('keeps independent plan loading visible beside an empty successful legacy feed', () => {
  state.status = 'loading';
  render(<PetActivityPage />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading prepared plans…');
  expect(screen.queryByText('No pet jobs yet')).not.toBeInTheDocument();
});

it('offers a plan-specific retry when the independent plan feed fails', async () => {
  state.status = 'error';
  render(<PetActivityPage />);
  expect(screen.getByText('Prepared plans could not be loaded')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Retry plans' }));
  expect(state.retry).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('No pet jobs yet')).not.toBeInTheDocument();
});
