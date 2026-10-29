import type { Export, ExportFormat, NixClient } from '@nix/api-client';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportDialog } from '../../export/export-dialog';
import * as archiveRequests from '../../export/export-archive';

let client: NixClient;

vi.mock('../../api/api-client-provider', () => ({
  useApiClient: () => client,
}));

const EXPORT_ID = 'a1111111-1111-4111-8111-111111111111';
const ITEM_ID = 'a2222222-2222-4222-8222-222222222222';

const archiveFormat: ExportFormat = {
  format: 'nix',
  label: 'Archive',
  extension: 'nix',
  mediaType: 'application/vnd.nix.archive+zip',
  lossless: true,
  declaredLoss: [],
};
const pdfFormat: ExportFormat = {
  format: 'pdf',
  label: 'PDF',
  extension: 'pdf',
  mediaType: 'application/pdf',
  lossless: false,
  declaredLoss: ['Interactive views become fixed pages.'],
};

function exportState(status: Export['status'] = 'queued'): Export {
  const completed = status === 'completed';
  return {
    id: EXPORT_ID,
    itemId: ITEM_ID,
    workspaceId: 'a3333333-3333-4333-8333-333333333333',
    format: 'nix',
    scope: 'subtree',
    fileName: 'notes.nix',
    mediaType: 'application/vnd.nix.archive+zip',
    status,
    itemCount: completed ? 3 : null,
    omittedCount: completed ? 0 : null,
    byteLength: completed ? 128 : null,
    sha256: completed ? 'a'.repeat(64) : null,
    loss: [],
    omissions: [],
    failureCode: null,
    failureDetail: null,
    cancellationRequested: false,
    downloadReady: completed,
    createdAt: '2026-09-01T09:00:00+00:00',
    completedAt: completed ? '2026-09-01T09:00:02+00:00' : null,
    expiresAt: completed ? '2026-09-02T09:00:02+00:00' : null,
  };
}

function result(overrides: Partial<archiveRequests.ArchiveResult> = {}) {
  return {
    exportId: EXPORT_ID,
    fileName: 'notes.nix',
    downloadUrl: 'https://objects.example/notes.nix?signature=secret',
    capabilityExpiresAt: '2999-09-01T09:10:00+00:00',
    mediaType: 'application/vnd.nix.archive+zip',
    byteLength: 128,
    sha256: 'a'.repeat(64),
    itemCount: 3,
    omittedCount: 0,
    loss: [],
    omissions: [],
    ...overrides,
  } satisfies archiveRequests.ArchiveResult;
}

function fakeClient(formats: readonly ExportFormat[] = [pdfFormat, archiveFormat]): NixClient {
  return {
    query: vi.fn((endpoint: { operation: string }) => {
      if (endpoint.operation === 'exports.formats') {
        return Promise.resolve({ formats, observedAt: '2026-09-01T09:00:00+00:00' });
      }
      return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
    }),
    execute: vi.fn((endpoint: { operation: string }) => {
      if (endpoint.operation === 'exports.cancel') return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected command ${endpoint.operation}`));
    }),
  } as unknown as NixClient;
}

function open(props: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  const onClose = vi.fn();
  const rendered = render(
    <ExportDialog open itemId={ITEM_ID} hasChildren onClose={onClose} {...props} />,
  );
  return { onClose, ...rendered };
}

beforeEach(() => {
  client = fakeClient();
  vi.spyOn(archiveRequests, 'saveArchive').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('export format discovery', () => {
  it('shows that formats are loading instead of rendering stale hardcoded choices', () => {
    client = {
      query: vi.fn(() => new Promise(() => undefined)),
    } as unknown as NixClient;

    open();

    expect(screen.getByRole('status')).toHaveTextContent('Loading available export formats');
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('offers only formats advertised by active workers and prefers the lossless one', async () => {
    const epub: ExportFormat = {
      ...pdfFormat,
      format: 'epub',
      label: 'EPUB',
      extension: 'epub',
      mediaType: 'application/epub+zip',
      declaredLoss: ['Boards become static sections.'],
    };
    client = fakeClient([epub, archiveFormat]);

    open();

    const select = await screen.findByRole('combobox', { name: 'Format' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'EPUB (.epub)',
      'Archive (.nix)',
    ]);
    expect(select).toHaveValue('nix');
  });

  it('shows the selected worker’s declared loss before starting', async () => {
    const request = vi.spyOn(archiveRequests, 'requestArchive');
    open();

    await userEvent.selectOptions(await screen.findByRole('combobox', { name: 'Format' }), 'pdf');

    expect(screen.getByText(/Interactive views become fixed pages/)).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it('renders an honest empty state when no worker advertises a format', async () => {
    client = fakeClient([]);
    open();

    expect(
      await screen.findByText(/No export worker is currently advertising a format/),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('reports a catalog failure and lets the caller retry it', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        formats: [archiveFormat],
        observedAt: '2026-09-01T09:00:00+00:00',
      });
    client = { query, execute: vi.fn() } as unknown as NixClient;
    open();

    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('combobox', { name: 'Format' })).toHaveValue('nix');
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('the durable export job', () => {
  it('offers the scope choice only when the item has children', async () => {
    open({ hasChildren: false });

    await screen.findByRole('combobox', { name: 'Format' });
    expect(screen.queryByRole('group', { name: 'What to export' })).not.toBeInTheDocument();
  });

  it('reports queued and running work rather than looking idle', async () => {
    vi.spyOn(archiveRequests, 'requestArchive').mockImplementation(async (request) => {
      request.onStarted?.(exportState('queued'));
      request.onProgress?.(exportState('running'));
      return new Promise(() => undefined);
    });
    open();

    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Preparing the download');
    expect(screen.getByRole('button', { name: 'Exporting…' })).toBeDisabled();
  });

  it('cancels the exact active Core job', async () => {
    vi.spyOn(archiveRequests, 'requestArchive').mockImplementation(async (request) => {
      request.onStarted?.(exportState('queued'));
      return new Promise(() => undefined);
    });
    const cancel = vi.spyOn(archiveRequests, 'cancelArchive').mockResolvedValue();
    open();

    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    const cancelButtons = await screen.findAllByRole('button', { name: 'Cancel export' });
    const cancelButton = cancelButtons.at(-1);
    if (cancelButton === undefined) throw new Error('The cancel action was not rendered.');
    await userEvent.click(cancelButton);

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledWith(client, EXPORT_ID);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('export was cancelled');
  });

  it('closes after handing a complete capability to the browser', async () => {
    vi.spyOn(archiveRequests, 'requestArchive').mockResolvedValue({
      ok: true,
      value: result(),
    });
    const { onClose } = open();

    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(archiveRequests.saveArchive).toHaveBeenCalledWith(result());
  });

  it('stays open and reports actual losses and omissions after starting the download', async () => {
    vi.spyOn(archiveRequests, 'requestArchive').mockResolvedValue({
      ok: true,
      value: result({
        itemCount: 42,
        omittedCount: 2,
        loss: ['A board became a static list.'],
        omissions: ['One deleted item was omitted.'],
      }),
    });
    const { onClose } = open();

    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('42 items were exported');
    expect(notice).toHaveTextContent('2 items were omitted');
    expect(notice).toHaveTextContent('A board became a static list');
    expect(archiveRequests.saveArchive).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows a durable worker refusal and permits a fresh attempt', async () => {
    const request = vi
      .spyOn(archiveRequests, 'requestArchive')
      .mockResolvedValueOnce({
        ok: false,
        cancelled: false,
        error: 'The PDF converter rejected this document.',
      })
      .mockResolvedValueOnce({ ok: true, value: result() });
    const { onClose } = open();

    await userEvent.click(await screen.findByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF converter rejected');
    await userEvent.click(screen.getByRole('button', { name: 'Export' }));

    await waitFor(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
