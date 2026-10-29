import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';
import { TemplateLibraryPage } from '../../templates/library/template-library-page';

const settings = vi.hoisted(() => ({ enabled: true }));
vi.mock('@nix/web-platform/api/use-pet-settings', () => ({
  usePetSettings: () => ({ saved: { settings: { enabled: settings.enabled } } }),
}));
vi.mock('../../templates/template-library-context', () => ({
  useTemplateLibrary: () => ({
    templates: [],
    status: 'ready',
    capabilities: { canManage: false },
    reload: () => undefined,
  }),
}));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({ useApiClient: () => ({}) }));
vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: '33333333-3333-4333-8333-333333333333' }),
}));

function Location() {
  const location = useLocation();
  return <div>{`${location.pathname}${location.search}`}</div>;
}

it('offers Design one with your pet when pets are enabled', async () => {
  settings.enabled = true;
  render(
    <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333/templates']}>
      <TemplateLibraryPage />
      <Location />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: 'Design one with your pet' }));
  expect(screen.getByText('/w/33333333-3333-4333-8333-333333333333?pet=design')).toBeVisible();
});

it('hides the Design entry point when pets are disabled', () => {
  settings.enabled = false;
  render(
    <MemoryRouter>
      <TemplateLibraryPage />
    </MemoryRouter>,
  );
  expect(
    screen.queryByRole('button', { name: 'Design one with your pet' }),
  ).not.toBeInTheDocument();
});
