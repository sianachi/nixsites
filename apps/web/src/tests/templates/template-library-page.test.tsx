import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../app';
import {
  STUB_TEMPLATE_IMPORT_ID,
  STUB_TEMPLATES,
  STUB_WORKSPACE,
  item,
  stubCoreApi,
  type StubTemplate,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { findByAriaLabel } from '@nix/web-foundation/testing/by-aria-label';

beforeEach(() => {
  signedIn();
  sessionStorage.clear();
});

const USER_TEMPLATE: StubTemplate = {
  id: 'a8888888-8888-4888-8888-888888888888',
  workspaceId: STUB_WORKSPACE.id,
  title: 'Weekly planning',
  description: 'The team planning board.',
  origin: 'user',
  revision: 1,
  includeBody: false,
  includeChildren: false,
  fieldCount: 2,
  viewCount: 1,
  childCount: 0,
  viewKinds: ['board'],
  capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
  updatedAt: '2026-08-16T09:00:00.000Z',
};
const TEMPLATE_IMPORT_DIGEST = 'a'.repeat(64);

describe('the workspace template library', () => {
  it('searches the server-backed library without showing templates in view settings', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templates: [...STUB_TEMPLATES, USER_TEMPLATE] });
    renderAt(<App />, '/templates');

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Kanban' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    expect(
      await screen.findByRole('img', {
        name: 'Weekly planning template preview, Weekly planning view',
      }),
    ).toHaveAttribute('src', expect.stringContaining('data:image/svg+xml'));

    await user.type(screen.getByRole('searchbox', { name: /search templates/i }), 'weekly');

    expect(screen.getByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Kanban' })).not.toBeInTheDocument();
  });

  it('keeps managed templates read-only and explains that in the edit route', async () => {
    const managed = STUB_TEMPLATES.find((template) => template.title === 'Kanban');
    expect(managed).toBeDefined();
    if (managed === undefined) return;
    stubCoreApi();
    renderAt(<App />, `/templates/${managed.id}/edit`);

    expect(await screen.findByRole('heading', { name: 'Managed template' })).toBeVisible();
    expect(screen.getByText(/read-only/i)).toBeVisible();
  });

  it('edits a workspace template and its starting item through the studio', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ templates: [USER_TEMPLATE] });
    renderAt(<App />, `/templates/${USER_TEMPLATE.id}/edit`);

    expect(await screen.findByRole('heading', { name: /edit weekly planning/i })).toBeVisible();
    await user.clear(screen.getByRole('textbox', { name: 'Name' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Weekly delivery');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.clear(screen.getByRole('textbox', { name: 'Item name' }));
    await user.type(screen.getByRole('textbox', { name: 'Item name' }), 'Delivery workspace');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    await user.clear(screen.getByRole('textbox', { name: 'Field name' }));
    await user.type(screen.getByRole('textbox', { name: 'Field name' }), 'Priority');
    await user.click(screen.getByRole('button', { name: 'Add field rule' }));
    expect(
      await screen.findByRole('option', { name: 'Delivery workspace · Priority' }),
    ).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'View name' }));
    await user.type(screen.getByRole('textbox', { name: 'View name' }), 'Delivery board');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('heading', { name: 'Weekly delivery' })).toBeVisible();
    const written = writes.templateItems[0]?.body;
    const schema = written?.schema as { readonly properties?: readonly unknown[] } | undefined;
    const views = written?.views as { readonly views?: readonly unknown[] } | undefined;
    expect(written?.title).toBe('Delivery workspace');
    expect(schema?.properties).toHaveLength(1);
    expect(schema?.properties?.[0]).toMatchObject({ label: 'Priority', type: 'text' });
    expect(views?.views).toHaveLength(1);
    expect(views?.views?.[0]).toMatchObject({ name: 'Delivery board', kind: 'board' });
  });

  // 30s rather than the file-wide 15s, and the number is measured rather than guessed: this case
  // drives eight recipes through the staged editor and takes 4.3s alone, consistently. The suite
  // runs its files in parallel, and the load factor on this machine is about 3.5x - which left it
  // inside the ceiling at 1,532 tests and outside it at 1,584, so goal 2.1-2.3's own tests are what
  // tipped it. Raising this one test's ceiling rather than the file's keeps every other case here
  // held to the tighter bound; the standing note about Vitest timeouts under load is in AGENTS.md.
  it('adds and configures every structured view type in the staged editor', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ templates: [USER_TEMPLATE] });
    renderAt(<App />, `/templates/${USER_TEMPLATE.id}/edit`);

    expect(await screen.findByRole('heading', { name: /edit weekly planning/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const kind = screen.getByRole('combobox', { name: 'New view type' });
    for (const recipe of [
      'calendar',
      'timeline',
      'gallery',
      'sheet',
      'form',
      'interactive-form',
      'query',
      'list',
    ]) {
      await user.selectOptions(kind, recipe);
      await user.click(screen.getByRole('button', { name: 'Add view' }));
    }

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Initial calendar view' }),
      'month',
    );
    const primaryCompanion = screen.getAllByRole('combobox', { name: 'Companion view' }).at(0);
    if (primaryCompanion === undefined)
      throw new Error('The primary companion choice is required.');
    await user.selectOptions(primaryCompanion, 'Calendar');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Companion placement' }),
      'beside',
    );
    const preview = await findByAriaLabel('Template preview');
    expect(within(preview).getByText('Fields').parentElement).toHaveTextContent('7');
    expect(within(preview).getByText('Views').parentElement).toHaveTextContent('9');
    expect(within(preview).getByText('interactive form')).toBeVisible();
    expect(within(preview).getByText('query')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByRole('heading', { name: 'Weekly planning' });
    const written = writes.templateItems[0]?.body;
    const schema = written?.schema as
      | { readonly properties?: readonly { readonly key: string; readonly type: string }[] }
      | undefined;
    const saved = written?.views as
      | {
          readonly views?: readonly {
            readonly id: string;
            readonly kind: string;
            readonly mode?: string | null;
            readonly companionViewId?: string | null;
            readonly companionPlacement?: string | null;
          }[];
        }
      | undefined;
    expect(saved?.views?.map((view) => view.kind)).toEqual([
      'board',
      'calendar',
      'timeline',
      'gallery',
      'sheet',
      'form',
      'interactive_form',
      'query',
      'list',
    ]);
    expect(saved?.views?.[0]).toMatchObject({
      companionViewId: saved?.views?.[1]?.id,
      companionPlacement: 'beside',
    });
    expect(saved?.views?.[1]).toMatchObject({ mode: 'month' });
    expect(schema?.properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'starts', type: 'timestamp' }),
        expect.objectContaining({ key: 'cover', type: 'image' }),
        expect.objectContaining({ key: 'response', type: 'text' }),
      ]),
    );
  }, 30_000);

  it('opens the staged document editor for body content included in a template', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templates: [{ ...USER_TEMPLATE, includeBody: true }] });
    renderAt(<App />, `/templates/${USER_TEMPLATE.id}/edit`);

    expect(await screen.findByRole('heading', { name: /edit weekly planning/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Body' })).toBeVisible();
    expect(screen.getByLabelText('Note body')).toBeVisible();
  });

  it('explains an expired recovered draft before starting a replacement', async () => {
    const user = userEvent.setup();
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:edit:template:${USER_TEMPLATE.id}`,
      JSON.stringify({
        scope: `template:${USER_TEMPLATE.id}`,
        title: 'Recovered weekly planning',
        description: 'Local field and view changes remain.',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000020',
        operationId: 'a0000000-0000-4000-8000-000000000021',
        expiresAt: '2026-08-15T09:00:00.000Z',
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    stubCoreApi({ templates: [USER_TEMPLATE], templateDraftUnavailable: true });
    renderAt(<App />, `/templates/${USER_TEMPLATE.id}/edit`);

    const notice = await screen.findByRole('alert');
    const heading = within(notice).getByRole('heading', {
      name: 'This saved draft is no longer available',
    });
    expect(heading).toBeVisible();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(notice).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText(/cannot be recovered/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try to resume again' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Discard local recovery' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Start a fresh draft' }));

    expect(await screen.findByRole('heading', { name: /edit weekly planning/i })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Recovered weekly planning');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/draft available until/i)).toBeVisible();
  });

  it('keeps a concurrent draft conflict distinct from expired local recovery', async () => {
    stubCoreApi({ templates: [USER_TEMPLATE], templateDraftConflict: true });
    renderAt(<App />, `/templates/${USER_TEMPLATE.id}/edit`);

    const notice = await screen.findByRole('alert');
    const heading = within(notice).getByRole('heading', {
      name: 'Another template draft is active',
    });
    expect(heading).toBeVisible();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(notice).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText(/another tab must be finished or discarded first/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to templates' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'This saved draft is no longer available' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start a fresh draft' })).not.toBeInTheDocument();
  });

  it('deletes a workspace template without changing items made from it', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templates: [USER_TEMPLATE] });
    renderAt(<App />, '/templates');

    await screen.findByRole('heading', { name: 'Weekly planning' });
    await user.click(screen.getByRole('button', { name: /delete weekly planning/i }));
    expect(screen.getByRole('dialog', { name: /delete this template/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete template' }));

    expect(await screen.findByRole('heading', { name: 'No templates yet' })).toBeVisible();
  });

  it('offers template actions on a held touch and confirms deletion before changing the library', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templates: [USER_TEMPLATE] });
    renderAt(<App />, '/templates');

    const card = await screen.findByRole('group', { name: 'Weekly planning template' });
    fireEvent(
      card,
      Object.assign(new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }), {
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
      }),
    );
    const menu = await screen.findByRole('menu', { name: 'Weekly planning template actions' });
    fireEvent.pointerUp(card, { pointerType: 'touch' });

    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((action) => action.textContent),
    ).toEqual(['Use template', 'Edit', 'Download', 'Delete']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete this template?' });
    expect(confirmation).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    await user.click(within(confirmation).getByRole('button', { name: 'Keep template' }));
    expect(screen.getByRole('group', { name: 'Weekly planning template' })).toBeVisible();

    screen.getByRole('button', { name: 'Use Weekly planning template' }).focus();
    await user.keyboard('{Shift>}{F10}{/Shift}');
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete template' }));
    expect(await screen.findByRole('heading', { name: 'No templates yet' })).toBeVisible();
  });

  it('discards the staged subtree without changing the active template', async () => {
    const user = userEvent.setup();
    stubCoreApi({ templates: [USER_TEMPLATE] });
    renderAt(<App />, '/templates');

    await user.click(await screen.findByRole('button', { name: 'Edit Weekly planning template' }));
    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Should not be saved');
    await user.click(screen.getByRole('button', { name: 'Cancel template setup' }));
    await user.click(screen.getByRole('button', { name: 'Discard setup' }));

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Should not be saved' })).not.toBeInTheDocument();
  });

  it('lets readers browse and download without offering workspace-changing actions', async () => {
    const user = userEvent.setup();
    const readerTemplate: StubTemplate = {
      ...USER_TEMPLATE,
      capabilities: {
        canEdit: false,
        canDelete: false,
        canExport: true,
        canApply: false,
      },
    };
    stubCoreApi({ templates: [readerTemplate], canManageTemplates: false });
    renderAt(<App />, '/templates');

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download Weekly planning' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete weekly planning/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import template' })).not.toBeInTheDocument();

    const card = screen.getByRole('group', { name: 'Weekly planning template' });
    const download = screen.getByRole('button', { name: 'Download Weekly planning' });
    download.focus();
    fireEvent.contextMenu(card, { clientX: 20, clientY: 20 });
    const menu = screen.getByRole('menu', { name: 'Weekly planning template actions' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((action) => action.textContent),
    ).toEqual(['Download']);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(download).toHaveFocus());
  });

  it('hides item-level template writes from readers', async () => {
    const note = item({
      id: 'a7777777-0000-4000-8000-000000000001',
      title: 'Reader note',
    });
    const readerTemplates = STUB_TEMPLATES.map((template) => ({
      ...template,
      capabilities: { ...template.capabilities, canApply: false },
    }));
    stubCoreApi({ items: [note], templates: readerTemplates, canManageTemplates: false });
    renderAt(<App />, `/?item=${note.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    expect(screen.getByRole('menuitem', { name: 'Export' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Apply template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Save as template' })).not.toBeInTheDocument();
  });

  it('offers Apply from template capability without granting template management', async () => {
    const note = item({
      id: 'a7777777-0000-4000-8000-000000000002',
      title: 'Writer note',
    });
    stubCoreApi({ items: [note], canManageTemplates: false });
    renderAt(<App />, `/?item=${note.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Apply template' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Save as template' })).not.toBeInTheDocument();
  });

  it('does not offer Apply when a manager has no applicable template', async () => {
    const note = item({
      id: 'a7777777-0000-4000-8000-000000000003',
      title: 'Manager note',
    });
    const unavailableTemplates = STUB_TEMPLATES.map((template) => ({
      ...template,
      capabilities: { ...template.capabilities, canApply: false },
    }));
    stubCoreApi({ items: [note], templates: unavailableTemplates, canManageTemplates: true });
    renderAt(<App />, `/?item=${note.id}`);

    await userEvent.click(await screen.findByRole('button', { name: 'Item actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Save as template' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Apply template' })).not.toBeInTheDocument();
  });

  it('identifies file-managed templates without offering edits', async () => {
    const managed: StubTemplate = {
      ...USER_TEMPLATE,
      id: 'a8888888-0000-4000-8000-000000000002',
      origin: 'managed',
      capabilities: { canEdit: false, canDelete: false, canExport: true, canApply: true },
    };
    stubCoreApi({ templates: [managed] });
    renderAt(<App />, '/templates');

    expect(await screen.findByText('Managed from file')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('duplicates read-only templates into editable workspace templates', async () => {
    const user = userEvent.setup();
    const kanban = STUB_TEMPLATES.find((template) => template.title === 'Kanban');
    expect(kanban).toBeDefined();
    if (kanban === undefined) return;
    const managed: StubTemplate = {
      ...USER_TEMPLATE,
      id: 'a8888888-0000-4000-8000-000000000002',
      title: 'Managed planning',
      origin: 'managed',
      capabilities: { canEdit: false, canDelete: false, canExport: true, canApply: true },
    };
    const writes = stubCoreApi({ templates: [kanban, managed] });
    renderAt(<App />, '/templates');

    expect(await screen.findByRole('button', { name: 'Duplicate Kanban' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Duplicate Managed planning' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use Kanban template' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Use Managed planning template' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Duplicate Managed planning' }));

    expect(await screen.findByRole('heading', { name: 'Edit Managed planning' })).toBeVisible();
    const name = screen.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Managed planning');
    expect(name).toBeEnabled();
    await user.clear(name);
    await user.type(name, 'Managed planning copy');
    expect(name).toHaveValue('Managed planning copy');
    expect(writes.templateImports).toEqual([TEMPLATE_IMPORT_DIGEST]);
    expect(writes.templateImportCommitIds).toEqual([STUB_TEMPLATE_IMPORT_ID]);
    expect(writes.templateUploadBodies).toHaveLength(1);
    expect(writes.templateExports).toEqual([managed.id]);
    expect(writes.templateImportIdempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([input, init]) =>
            (init?.method ?? 'GET').toUpperCase() === 'PATCH' &&
            requestUrl(input).includes('/api/v1/templates/'),
        ),
    ).toBe(false);
  });

  it('recovers a lost duplicate commit response from the same durable import', async () => {
    const user = userEvent.setup();
    const managed: StubTemplate = {
      ...USER_TEMPLATE,
      id: 'a8888888-0000-4000-8000-000000000003',
      title: 'Managed review',
      origin: 'managed',
      capabilities: { canEdit: false, canDelete: false, canExport: true, canApply: true },
    };
    const writes = stubCoreApi({
      templates: [managed],
      templateDuplicateResponseLostOnce: true,
    });
    renderAt(<App />, '/templates');

    await user.click(await screen.findByRole('button', { name: 'Duplicate Managed review' }));

    expect(await screen.findByRole('heading', { name: 'Edit Managed review' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Managed review');
    expect(writes.templateExports).toEqual([managed.id]);
    expect(writes.templateUploadBodies).toHaveLength(1);
    expect(writes.templateImports).toEqual([TEMPLATE_IMPORT_DIGEST]);
    expect(writes.templateImportIdempotencyKeys).toHaveLength(1);
    expect(writes.templateImportCommitIds).toEqual([STUB_TEMPLATE_IMPORT_ID]);
    expect(writes.templateImportReads).toEqual([STUB_TEMPLATE_IMPORT_ID, STUB_TEMPLATE_IMPORT_ID]);
  });

  it('shows the server refusal when a read-only template cannot be duplicated', async () => {
    const user = userEvent.setup();
    const kanban = STUB_TEMPLATES.find((template) => template.title === 'Kanban');
    expect(kanban).toBeDefined();
    if (kanban === undefined) return;
    const writes = stubCoreApi({ templates: [kanban], templateDuplicateCommitFails: true });
    renderAt(<App />, '/templates');

    await user.click(await screen.findByRole('button', { name: 'Duplicate Kanban' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This managed template is unavailable.',
    );

    await user.click(screen.getByRole('button', { name: 'Duplicate Kanban' }));
    await waitFor(() => {
      expect(writes.templateImports).toEqual([TEMPLATE_IMPORT_DIGEST, TEMPLATE_IMPORT_DIGEST]);
    });
    expect(writes.templateImportIdempotencyKeys).toHaveLength(1);
    expect(writes.templateImportCommitIds).toEqual([
      STUB_TEMPLATE_IMPORT_ID,
      STUB_TEMPLATE_IMPORT_ID,
    ]);
    expect(writes.templateExports).toEqual([kanban.id]);
    expect(writes.templateUploadBodies).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Start a separate duplicate' }));
    await waitFor(() => {
      expect(writes.templateImportIdempotencyKeys).toHaveLength(2);
      expect(writes.templateImports).toHaveLength(3);
    });
    expect(writes.templateImportIdempotencyKeys[1]).not.toBe(
      writes.templateImportIdempotencyKeys[0],
    );
    expect(writes.templateImportCancellations).toEqual([STUB_TEMPLATE_IMPORT_ID]);
    expect(writes.templateImportCommitIds.slice(0, 2)).toEqual([
      STUB_TEMPLATE_IMPORT_ID,
      STUB_TEMPLATE_IMPORT_ID,
    ]);
    expect(writes.templateImportCommitIds[2]).not.toBe(STUB_TEMPLATE_IMPORT_ID);
    expect(writes.templateExports).toEqual([kanban.id, kanban.id]);
    expect(writes.templateUploadBodies).toHaveLength(2);
    expect(writes.templateUploadBodies[1]).not.toBe(writes.templateUploadBodies[0]);
  });

  it('does not offer template duplication to readers', async () => {
    const managed: StubTemplate = {
      ...USER_TEMPLATE,
      origin: 'managed',
      capabilities: { canEdit: false, canDelete: false, canExport: true, canApply: false },
    };
    stubCoreApi({ templates: [managed], canManageTemplates: false });
    renderAt(<App />, '/templates');

    expect(await screen.findByRole('heading', { name: 'Weekly planning' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download Weekly planning' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Duplicate Weekly planning' }),
    ).not.toBeInTheDocument();
  });
});
