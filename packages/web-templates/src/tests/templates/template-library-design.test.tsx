import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';
import { TemplateLibraryPage } from '../../templates/library/template-library-page';

const settings = vi.hoisted(() => ({ enabled: true }));
vi.mock('@nix/web-platform/api/use-pet-settings', () => ({
  usePetSettings: () => ({ saved: { settings: { enabled: settings.enabled } } }),
}));
const library = vi.hoisted(() => ({
  canManage: false,
  templates: [] as Record<string, unknown>[],
  reload: vi.fn(),
}));
vi.mock('../../templates/template-library-context', () => ({
  useTemplateLibrary: () => ({
    templates: library.templates,
    status: 'ready',
    capabilities: { canManage: library.canManage },
    reload: library.reload,
  }),
}));
const apiClient = vi.hoisted(() => ({ query: () => new Promise(() => undefined) }));
vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  // A stored template's card asks for its detail to draw a preview; these tests never answer.
  // One stable client: the page aborts its requests whenever the client changes.
  useApiClient: () => apiClient,
}));
const imports = vi.hoisted(() => ({
  begin: vi.fn(),
  commit: vi.fn(),
}));
vi.mock('../../templates/template-api', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  beginAndPreviewTemplate: imports.begin,
  commitAndWaitTemplate: imports.commit,
}));
const BUILT_INS = [
  {
    key: 'nix.goals',
    name: 'Goals',
    description: 'A few goals for the season.',
    itemCount: 6,
    viewKinds: ['timeline', 'board'],
    preview: null,
    archive: btoa('archive-bytes'),
  },
  {
    key: 'nix.inbox',
    name: 'Inbox',
    description: 'One place to drop everything.',
    itemCount: 7,
    viewKinds: ['checklist'],
    preview: null,
    archive: btoa('other'),
  },
];
vi.mock('../../templates/library/built-in-catalog', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadBuiltInTemplates: () => Promise.resolve(BUILT_INS),
}));
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

it('offers the built-in templates a workspace does not hold, and imports one on first use', async () => {
  settings.enabled = false;
  library.canManage = true;
  library.templates = [
    {
      id: '44444444-4444-4444-8444-444444444444',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      title: 'Inbox',
      description: null,
      origin: 'user',
      revision: 1,
      includeBody: false,
      includeChildren: false,
      fieldCount: 0,
      viewCount: 0,
      childCount: 0,
      viewKinds: [],
      capabilities: {
        canApply: false,
        canEdit: false,
        canDelete: false,
        canExport: false,
      },
      updatedAt: '2026-11-12T00:00:00Z',
    },
  ];
  imports.begin.mockResolvedValue({ id: 'import-1', preview: { digest: 'abc' } });
  imports.commit.mockResolvedValue({ result: { templateId: 'template-9' } });
  render(
    <MemoryRouter initialEntries={['/w/33333333-3333-4333-8333-333333333333/templates']}>
      <TemplateLibraryPage />
      <Location />
    </MemoryRouter>,
  );

  // Inbox is already in the workspace, so only Goals is offered.
  await userEvent.click(await screen.findByRole('button', { name: 'Add and use Goals template' }));
  expect(
    screen.queryByRole('button', { name: 'Add and use Inbox template' }),
  ).not.toBeInTheDocument();

  expect(
    await screen.findByText('/w/33333333-3333-4333-8333-333333333333/templates/template-9/create'),
  ).toBeVisible();
  const [, input, archive] = imports.begin.mock.calls[0] as [
    unknown,
    { fileName: string; byteLength: number },
    Blob,
  ];
  expect(input).toMatchObject({ fileName: 'nix.goals.nix', byteLength: 'archive-bytes'.length });
  expect(await archive.text()).toBe('archive-bytes');
  expect(imports.commit).toHaveBeenCalledWith(
    expect.anything(),
    'import-1',
    'abc',
    expect.anything(),
  );
  expect(library.reload).toHaveBeenCalled();
});

it('does not offer built-ins to someone who cannot manage the workspace templates', async () => {
  library.canManage = false;
  library.templates = [];
  render(
    <MemoryRouter>
      <TemplateLibraryPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText('No templates yet')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Add and use Goals template' }),
  ).not.toBeInTheDocument();
});
