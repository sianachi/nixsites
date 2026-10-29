import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import {
  STUB_TEMPLATE_IMPORT_ID,
  STUB_WORKSPACE,
  stubCoreApi,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';

beforeEach(() => {
  signedIn();
  sessionStorage.clear();
});

describe('template file import', () => {
  const digest = 'a'.repeat(64);

  it('validates and previews an archive before adding it to the library', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
    });
    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(
      screen.getByText('Validation complete. Review this preview before adding it to the library.')
        .parentElement,
    ).toHaveFocus();
    expect(screen.getAllByRole('heading', { name: '3' })).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImports).toEqual([digest]);
    expect(writes.templateImportIdempotencyKeys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(writes.templateUploadBodies).toHaveLength(1);
  });

  it('keeps a digest-bound preview until the user discards a changed-file refusal', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ templateFileChanged: true });
    renderAt(<App />, '/templates/import');

    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
    });
    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The selected file changed after preview. Preview it again before importing. Discard this attempt before previewing the file again.',
    );
    expect(screen.getByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByRole('button', { name: /validate file/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add to library/i })).toBeDisabled();
    expect(writes.templateImportCancellations).toEqual([]);
    expect(sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Discard attempt' }));
    await user.click(screen.getByRole('button', { name: 'Discard import' }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImportCancellations).toEqual([STUB_TEMPLATE_IMPORT_ID]);
  });

  it('commits a recovered durable preview without selecting or uploading the file again', async () => {
    const user = userEvent.setup();
    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
      lastModified: 1_786_867_200_000,
    });
    const attempt = 'a0000000-0000-4000-8000-000000000031';
    sessionStorage.setItem(
      `nix:template-import:${STUB_WORKSPACE.id}`,
      JSON.stringify({
        importId: STUB_TEMPLATE_IMPORT_ID,
        preview: {
          profile: {
            kind: 'template',
            version: 1,
            key: 'imported-template',
            name: 'Imported template',
            description: 'Validated from disk.',
            includeBody: true,
            includeChildren: true,
          },
          digest,
          rootItemType: 'note',
          itemCount: 3,
          bodyCount: 3,
          viewCount: 1,
        },
        idempotencyKey: attempt,
        fileIdentity: {
          name: archive.name,
          size: archive.size,
          lastModified: archive.lastModified,
        },
      }),
    );
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByText(/recovered preview is ready/i)).toBeVisible();
    expect(screen.getByText(/not local file bytes/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /add to library/i })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImportIdempotencyKeys).toEqual([]);
    expect(writes.templateUploadBodies).toEqual([]);
    expect(writes.templateImports).toEqual([digest]);
  });

  it('resumes a queued preview after reload when the same file is selected again', async () => {
    const user = userEvent.setup();
    const archive = new File(['archive bytes'], 'team-start.nix', {
      type: 'application/x-nix-template',
      lastModified: 1_786_867_200_000,
    });
    sessionStorage.setItem(
      `nix:template-import:${STUB_WORKSPACE.id}`,
      JSON.stringify({
        importId: STUB_TEMPLATE_IMPORT_ID,
        preview: null,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000031',
        fileIdentity: {
          name: archive.name,
          size: archive.size,
          lastModified: archive.lastModified,
        },
      }),
    );
    const writes = stubCoreApi({ templateImportReplayPreviewQueued: true });
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByText(/a previous attempt for team-start\.nix can be resumed/i),
    ).toBeVisible();
    expect(screen.getByText(/did not retain the archive bytes/i)).toBeVisible();
    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(writes.templateImportIdempotencyKeys).toEqual(['a0000000-0000-4000-8000-000000000031']);
    expect(writes.templateUploadBodies).toEqual([]);
    expect(writes.templateImportCancellations).toEqual([]);
  });

  it('persists only safe retry metadata across reload until the archive is selected again', async () => {
    const user = userEvent.setup();
    const archive = new File(['private archive bytes'], 'reload-safe.nix', {
      type: 'application/x-nix-template',
      lastModified: 1_786_867_200_000,
    });
    const writes = stubCoreApi();
    const firstRender = renderAt(<App />, '/templates/import');

    await user.upload(await screen.findByLabelText('Template file'), archive);
    const key = `nix:template-import:${STUB_WORKSPACE.id}`;
    const rawDraft = sessionStorage.getItem(key);
    const parsedDraft = JSON.parse(rawDraft ?? '{}') as Record<string, unknown>;
    expect(rawDraft).not.toBeNull();
    expect(rawDraft).not.toContain('private archive bytes');
    expect(parsedDraft).toMatchObject({
      importId: null,
      preview: null,
      fileIdentity: {
        name: archive.name,
        size: archive.size,
        lastModified: archive.lastModified,
      },
    });
    const recoveredIdempotencyKey = parsedDraft.idempotencyKey;
    if (typeof recoveredIdempotencyKey !== 'string') {
      throw new Error('The persisted retry identity is required.');
    }

    firstRender.unmount();
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByText(/a previous attempt for reload-safe\.nix can be resumed/i),
    ).toBeVisible();
    expect(screen.getByText(/did not retain the archive bytes/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /validate file/i })).toBeDisabled();

    await user.upload(screen.getByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));

    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(writes.templateImportIdempotencyKeys).toEqual([recoveredIdempotencyKey]);
    expect(writes.templateUploadBodies).toEqual([archive]);
  });

  it('retries transient preview failure with the same archive and durable identity', async () => {
    const user = userEvent.setup();
    const archive = new File(['retry archive'], 'retry-preview.nix', {
      type: 'application/x-nix-template',
    });
    const writes = stubCoreApi({ templateImportPreviewFailsOnce: true });
    renderAt(<App />, '/templates/import');

    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /template validation is temporarily unavailable.*same durable attempt is retained/i,
    );
    const retainedDraft = JSON.parse(
      sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`) ?? '{}',
    ) as { importId?: string; idempotencyKey?: string; preview?: unknown };
    expect(retainedDraft).toMatchObject({
      importId: STUB_TEMPLATE_IMPORT_ID,
      preview: null,
    });
    expect(screen.getByText('Selected: retry-preview.nix')).toBeVisible();
    expect(screen.getByRole('button', { name: /validate file/i })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /validate file/i }));

    await waitFor(() => {
      expect(writes.templateImportIdempotencyKeys).toHaveLength(2);
    });
    expect(await screen.findByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(writes.templateImportIdempotencyKeys).toEqual([
      retainedDraft.idempotencyKey,
      retainedDraft.idempotencyKey,
    ]);
    expect(writes.templateUploadBodies).toHaveLength(2);
    expect(writes.templateUploadBodies[0]).toBe(archive);
    expect(writes.templateUploadBodies[1]).toBe(archive);
    expect(writes.templateImportBegins).toEqual([
      {
        importId: STUB_TEMPLATE_IMPORT_ID,
        status: 'pending_upload',
        hasUploadCapability: true,
      },
      {
        importId: STUB_TEMPLATE_IMPORT_ID,
        status: 'pending_upload',
        hasUploadCapability: true,
      },
    ]);
    expect(writes.templateImportCancellations).toEqual([]);
  });

  it('retries transient commit failure with the same import and preview digest', async () => {
    const user = userEvent.setup();
    const archive = new File(['retry commit archive'], 'retry-commit.nix', {
      type: 'application/x-nix-template',
    });
    const writes = stubCoreApi({ templateImportCommitFailsOnce: true });
    renderAt(<App />, '/templates/import');

    await user.upload(await screen.findByLabelText('Template file'), archive);
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });
    const retainedDraft = sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`);
    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /template publication is temporarily unavailable.*durable attempt is retained/i,
    );
    expect(screen.getByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByRole('button', { name: /add to library/i })).toBeEnabled();
    expect(sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`)).toBe(retainedDraft);
    expect(writes.templateImportCancellations).toEqual([]);

    await user.click(screen.getByRole('button', { name: /add to library/i }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImportIdempotencyKeys).toHaveLength(1);
    expect(writes.templateUploadBodies).toEqual([archive]);
    expect(writes.templateImportCommitIds).toEqual([
      STUB_TEMPLATE_IMPORT_ID,
      STUB_TEMPLATE_IMPORT_ID,
    ]);
    expect(writes.templateImports).toEqual([digest, digest]);
    expect(sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`)).toBeNull();
  });

  it('cancels the durable preview before replacing its selected archive', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    await user.upload(
      await screen.findByLabelText('Template file'),
      new File(['first archive'], 'first.nix', { type: 'application/x-nix-template' }),
    );
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });

    await user.upload(
      screen.getByLabelText('Template file'),
      new File(['second archive'], 'second.nix', { type: 'application/x-nix-template' }),
    );

    await waitFor(() => {
      expect(writes.templateImportCancellations).toEqual([STUB_TEMPLATE_IMPORT_ID]);
    });
    expect(screen.queryByRole('heading', { name: 'Imported template' })).not.toBeInTheDocument();
    expect(screen.getByText('Selected: second.nix')).toBeVisible();
    expect(screen.getByRole('button', { name: /validate file/i })).toBeEnabled();
  });

  it('keeps the previous archive and recovery record when replacement cancellation fails', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ templateImportCancelFailsOnce: true });
    renderAt(<App />, '/templates/import');

    await user.upload(
      await screen.findByLabelText('Template file'),
      new File(['first archive'], 'first.nix', { type: 'application/x-nix-template' }),
    );
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });
    const retainedDraft = sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`);

    await user.upload(
      screen.getByLabelText('Template file'),
      new File(['second archive'], 'second.nix', { type: 'application/x-nix-template' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not be cancelled yet.*remains available to retry or discard/i,
    );
    expect(screen.getByRole('heading', { name: 'Imported template' })).toBeVisible();
    expect(screen.getByText('Selected: first.nix')).toBeVisible();
    expect(screen.queryByText('Selected: second.nix')).not.toBeInTheDocument();
    expect(sessionStorage.getItem(`nix:template-import:${STUB_WORKSPACE.id}`)).toBe(retainedDraft);
    expect(writes.templateImportCancellations).toEqual([STUB_TEMPLATE_IMPORT_ID]);

    await user.click(screen.getByRole('button', { name: 'Cancel template import' }));
    await user.click(screen.getByRole('button', { name: 'Discard import' }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImportCancellations).toEqual([
      STUB_TEMPLATE_IMPORT_ID,
      STUB_TEMPLATE_IMPORT_ID,
    ]);
  });

  it('cancels the durable preview when the user explicitly discards it', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi();
    renderAt(<App />, '/templates/import');

    await user.upload(
      await screen.findByLabelText('Template file'),
      new File(['archive'], 'discard.nix', { type: 'application/x-nix-template' }),
    );
    await user.click(screen.getByRole('button', { name: /validate file/i }));
    await screen.findByRole('heading', { name: 'Imported template' });
    await user.click(screen.getByRole('button', { name: 'Cancel template import' }));
    await user.click(screen.getByRole('button', { name: 'Discard import' }));

    expect(await screen.findByRole('heading', { name: 'Templates' })).toBeVisible();
    expect(writes.templateImportCancellations).toEqual([STUB_TEMPLATE_IMPORT_ID]);
  });

  it('does not recover an import preview saved for another workspace', async () => {
    const otherWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Other workspace',
      kind: 'shared' as const,
    };
    sessionStorage.setItem(
      `nix:template-import:${STUB_WORKSPACE.id}`,
      JSON.stringify({
        importId: STUB_TEMPLATE_IMPORT_ID,
        preview: {
          profile: {
            kind: 'template',
            version: 1,
            key: 'private-template',
            name: 'Private workspace preview',
            description: 'A preview that belongs to another workspace.',
            includeBody: false,
            includeChildren: false,
          },
          digest,
          rootItemType: 'note',
          itemCount: 1,
          bodyCount: 0,
          viewCount: 0,
        },
        idempotencyKey: 'a0000000-0000-4000-8000-000000000031',
      }),
    );
    stubCoreApi({ workspaces: [STUB_WORKSPACE, otherWorkspace] });
    renderAt(<App />, `/w/${otherWorkspace.id}/templates/import`);

    expect(await screen.findByRole('heading', { name: 'Import template' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Private workspace preview' }),
    ).not.toBeInTheDocument();
  });

  it('distinguishes a library access error from permission denial and offers retry', async () => {
    stubCoreApi({ templatesFail: true });
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByRole('heading', { name: 'Template library unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/template library could not be loaded/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText(/you cannot add or change them/i)).not.toBeInTheDocument();
  });

  it('explains permission denial without presenting it as a retryable access error', async () => {
    stubCoreApi({ canManageTemplates: false });
    renderAt(<App />, '/templates/import');

    expect(
      await screen.findByRole('heading', { name: 'Template import unavailable' }),
    ).toBeVisible();
    expect(screen.getByText(/you cannot add or change them/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});
