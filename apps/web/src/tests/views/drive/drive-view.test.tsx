import { fireEvent, screen, within } from '@testing-library/react';
import type * as apiClient from '@nix/api-client';
import { createNixClient, type NixClient } from '@nix/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aContainer } from '../../container-fixture';
import { renderAt as render } from '@nix/web-editor/testing/render-with-router';
import { aView } from '../../view-fixture';
import type { Item } from '../../../views/core/container-model';
import type { ContainerData } from '../../../views/core/use-container';
import { DriveView } from '../../../views/drive/drive-view';
import { ContainerView } from '../../../views/core/container-view';

/**
 * The drive view: a container's children as a file manager.
 *
 * Every test builds its own fake `NixClient` and its own fake `WorkspaceTree` rather than reaching
 * the real hooks - the drive fetches file facts lazily through the client (`fileByItem`) and moves
 * items through the tree (`move`), and a test about either wants to see exactly what was asked for
 * without a real network or a real workspace behind it.
 */

const WORKSPACE = 'a1000000-0000-4000-8000-000000000001';
const CONTAINER = 'c1000000-0000-4000-8000-000000000001';

function itemOf(overrides: Partial<Item> & { id: string; title: string }): Item {
  return {
    workspaceId: WORKSPACE,
    parentId: CONTAINER,
    type: 'note',
    hasChildren: false,
    seq: 1000,
    lifecycleState: 'active',
    properties: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const NOTE = itemOf({ id: 'i-note', title: 'Bravo note', type: 'note', seq: 1000 });
const FOLDER = itemOf({
  id: 'i-folder',
  title: 'Alpha folder',
  type: 'note',
  hasChildren: true,
  seq: 1500,
});
const FILE_A = itemOf({
  id: 'i-file-a',
  title: 'Charlie file',
  type: 'file',
  seq: 2000,
  updatedAt: '2026-02-01T00:00:00Z',
});
const FILE_B = itemOf({
  id: 'i-file-b',
  title: 'Delta file',
  type: 'file',
  seq: 2500,
  updatedAt: '2026-03-01T00:00:00Z',
});

function fileVersion(id: string, fileName: string, byteLength: number) {
  return {
    id,
    version: 1,
    fileName,
    mediaType: 'text/plain',
    byteLength,
    sha256: '1'.repeat(64),
    previewable: false,
    pixelWidth: null,
    pixelHeight: null,
    createdAt: '2026-02-01T00:00:00Z',
    current: true,
  };
}

function fileRecordFor(itemId: string, fileName: string, byteLength: number) {
  const version = fileVersion(`${itemId}-v1`, fileName, byteLength);
  return { itemId, workspaceId: WORKSPACE, current: version, versions: [version] };
}

const { moveMock, reloadMock, fetchFileContentMock, beginUploadMock, uploadAndCompleteFileMock } =
  vi.hoisted(() => ({
    moveMock: vi.fn<(itemId: string) => Promise<{ refusal: string | null }>>(() =>
      Promise.resolve({ refusal: null }),
    ),
    reloadMock: vi.fn(() => Promise.resolve()),
    fetchFileContentMock: vi.fn(() => Promise.resolve({ blob: new Blob(['x']) })),
    beginUploadMock: vi.fn((input: unknown) => ({ operation: 'files.upload.begin', body: input })),
    uploadAndCompleteFileMock: vi.fn(() =>
      Promise.resolve({
        itemId: 'new',
        workspaceId: 'a1000000-0000-4000-8000-000000000001',
        current: {
          id: 'new-v1',
          version: 1,
          fileName: 'new.txt',
          mediaType: 'text/plain',
          byteLength: 3,
          sha256: '1'.repeat(64),
          previewable: false,
          pixelWidth: null,
          pixelHeight: null,
          createdAt: '2026-02-01T00:00:00Z',
          current: true,
        },
        versions: [],
      }),
    ),
  }));

vi.mock('@nix/web-workspaces/workspaces/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: WORKSPACE }),
  useOptionalWorkspace: () => null,
}));

vi.mock('../../../items/use-workspace-tree', () => ({
  useWorkspaceTree: () => ({
    status: 'ready',
    error: null,
    items: [],
    childrenOf: () => [],
    isExpanded: () => false,
    isLoadingChildren: () => false,
    isLocked: () => false,
    breadcrumbs: () => [],
    find: () => null,
    reveal: () => Promise.resolve(),
    revealOf: () => null,
    retryReveal: () => Promise.resolve(),
    isCreating: false,
    isSaving: false,
    toggle: () => Promise.resolve(),
    expand: () => Promise.resolve(),
    create: () => Promise.resolve({ id: null, refusal: null }),
    createStructured: () => Promise.resolve({ id: null, refusal: null }),
    rename: () => Promise.resolve(),
    move: moveMock,
    remove: () => Promise.resolve({ refusal: null }),
    restore: () => Promise.resolve({ refusal: null }),
    reload: () => Promise.resolve(),
  }),
}));

let client: NixClient;

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => client,
  useOptionalApiClient: () => null,
}));

vi.mock('@nix/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('@nix/api-client');
  return {
    ...actual,
    files: {
      ...actual.files,
      beginUpload: beginUploadMock,
      uploadAndCompleteFile: uploadAndCompleteFileMock,
      fetchFileContent: fetchFileContentMock,
    },
  };
});

function fakeClient(): NixClient {
  return {
    cache: createNixClient({
      baseUrl: 'http://localhost',
      tokens: {
        getAccessToken: () => Promise.resolve(null),
        refreshAccessToken: () => Promise.resolve(null),
      },
    }).cache,
    query: vi.fn((endpoint: { operation: string; path: string }) => {
      if (endpoint.operation === 'files.get') {
        if (endpoint.path.includes(FILE_A.id))
          return Promise.resolve(fileRecordFor(FILE_A.id, 'notes.txt', 128));
        if (endpoint.path.includes(FILE_B.id))
          return Promise.resolve(fileRecordFor(FILE_B.id, 'report.csv', 4096));
        return Promise.reject(new Error(`Unexpected file id in ${endpoint.path}`));
      }
      return Promise.reject(new Error(`Unexpected query ${endpoint.operation}`));
    }),
    execute: vi.fn(() => Promise.resolve({ id: 'upload-id' })),
  } as unknown as NixClient;
}

function driveOf(options: {
  readonly items: readonly Item[];
  readonly onOpen?: (id: string) => void;
  readonly layout?: string;
}) {
  const container: ContainerData = aContainer({
    itemId: null, // a workspace root: no "Parent" destination to resolve
    children: [...options.items],
    reload: reloadMock,
  });

  return (
    <DriveView
      container={container}
      view={aView({ kind: 'drive', layout: options.layout ?? 'list' })}
      onOpen={options.onOpen ?? (() => undefined)}
    />
  );
}

function selectableDriveOf(options: {
  readonly items: readonly Item[];
  readonly onOpen?: (id: string) => void;
  readonly onOpenBeside?: (id: string) => void;
  readonly layout?: string;
}) {
  return (
    <ContainerView
      container={aContainer({ itemId: null, children: [...options.items], reload: reloadMock })}
      view={aView({ kind: 'drive', layout: options.layout ?? 'list' })}
      onOpen={options.onOpen ?? (() => undefined)}
      onOpenBeside={options.onOpenBeside}
    />
  );
}

beforeEach(() => {
  client = fakeClient();
  moveMock.mockReset();
  moveMock.mockImplementation(() => Promise.resolve({ refusal: null }));
  reloadMock.mockClear();
  fetchFileContentMock.mockClear();
  beginUploadMock.mockClear();
  uploadAndCompleteFileMock.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:nix-drive'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the drive view', () => {
  it.each(['list', 'grid'])('offers item actions from the %s entry context menu', (layout) => {
    const onOpen = vi.fn();
    render(selectableDriveOf({ items: [NOTE, FOLDER], onOpen, layout }));

    fireEvent.contextMenu(screen.getByRole('button', { name: NOTE.title }), {
      clientX: 10,
      clientY: 10,
    });
    const menu = screen.getByRole('menu', { name: `${NOTE.title} actions` });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Select' }));
    expect(screen.getByRole('checkbox', { name: `Select ${NOTE.title}` })).toBeChecked();

    fireEvent.keyDown(screen.getByRole('button', { name: NOTE.title }), {
      key: 'F10',
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith(NOTE.id);
  });

  it('downloads a file from its context menu without selecting other files', async () => {
    render(driveOf({ items: [FILE_A, FILE_B] }));
    fireEvent.contextMenu(screen.getByRole('button', { name: FILE_A.title }), {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    await vi.waitFor(() => {
      expect(fetchFileContentMock).toHaveBeenCalledOnce();
    });
    expect(fetchFileContentMock).toHaveBeenCalledWith(client, FILE_A.id);
  });

  it('offers the same actions from a visible button on every row, for touch', async () => {
    render(driveOf({ items: [FILE_A, FILE_B] }));
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${FILE_A.title}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download' }));
    await vi.waitFor(() => {
      expect(fetchFileContentMock).toHaveBeenCalledWith(client, FILE_A.id);
    });
  });

  it('draws a row for every child, naming its kind and icon by its body kind', async () => {
    render(driveOf({ items: [NOTE, FOLDER, FILE_A] }));

    expect(await screen.findByRole('button', { name: 'Bravo note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha folder' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Charlie file' })).toBeInTheDocument();

    // The row's own <tr> carries the kind and size cells; find it from the name button.
    const row = screen.getByRole('button', { name: 'Alpha folder' }).closest('tr');
    if (row === null) throw new Error('The row did not render inside a <tr>.');
    // Twice: the Kind column, and the one-line detail a phone row shows in its place.
    expect(within(row).getAllByText('Note')).toHaveLength(2);
  });

  it('fetches file facts lazily and shows the size once it resolves', async () => {
    render(driveOf({ items: [FILE_A] }));

    const row = screen.getByRole('button', { name: 'Charlie file' }).closest('tr');
    if (row === null) throw new Error('The row did not render inside a <tr>.');
    expect(within(row).getByText('—')).toBeInTheDocument();

    expect(await within(row).findByText('128 B')).toBeInTheDocument();
    expect(within(row).getByText('TXT')).toBeInTheDocument();
  });

  it('sorts by name ascending by default and reverses on a second click', () => {
    render(driveOf({ items: [FILE_B, NOTE, FOLDER] }));

    const names = () =>
      screen
        .getAllByRole('button', { name: /^\w+ (note|folder|file)$/i })
        .map((b) => b.textContent);
    expect(names()).toEqual(['Alpha folder', 'Bravo note', 'Delta file']);

    fireEvent.click(screen.getByRole('button', { name: /^Name/ }));
    expect(names()).toEqual(['Delta file', 'Bravo note', 'Alpha folder']);
  });

  it('uses the shared selection tray and downloads only selected files', async () => {
    render(selectableDriveOf({ items: [NOTE, FILE_A, FILE_B] }));

    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NOTE.title}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${FILE_A.title}` }));
    const tray = screen.getByRole('toolbar', { name: 'Selected items' });
    expect(within(tray).getByText('2 selected')).toBeVisible();
    expect(within(tray).getByRole('button', { name: 'Select all 3' })).toBeVisible();
    expect(within(tray).getByRole('button', { name: 'Clear' })).toBeVisible();

    fireEvent.click(within(tray).getByRole('button', { name: 'Download' }));

    await vi.waitFor(() => {
      expect(fetchFileContentMock).toHaveBeenCalledOnce();
    });
    expect(fetchFileContentMock).toHaveBeenCalledWith(client, FILE_A.id);
  });

  it('uses the shared Cmd/Ctrl-click, Shift-range, and Select all selection gestures', () => {
    render(selectableDriveOf({ items: [FOLDER, NOTE, FILE_A] }));

    fireEvent.click(screen.getByRole('button', { name: FOLDER.title }), { ctrlKey: true });
    fireEvent.click(screen.getByRole('button', { name: FILE_A.title }), { shiftKey: true });
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('3 selected');

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.keyDown(screen.getByRole('button', { name: NOTE.title }), {
      key: 'a',
      ctrlKey: true,
    });
    expect(screen.getByRole('toolbar', { name: 'Selected items' })).toHaveTextContent('3 selected');
  });

  it.each(['list', 'grid'])('opens the correct %s item beside with Alt-click', (layout) => {
    const onOpen = vi.fn();
    const onOpenBeside = vi.fn();
    render(selectableDriveOf({ items: [NOTE], onOpen, onOpenBeside, layout }));
    fireEvent.click(screen.getByRole('button', { name: NOTE.title }), { altKey: true });
    expect(onOpenBeside).toHaveBeenCalledWith(NOTE.id);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: NOTE.title }));
    expect(onOpen).toHaveBeenCalledWith(NOTE.id);
  });

  it('keeps selected rows together when dragging them onto a drive folder', async () => {
    render(selectableDriveOf({ items: [FOLDER, NOTE, FILE_A] }));

    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${NOTE.title}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${FILE_A.title}` }));
    const source = screen.getByRole('button', { name: FILE_A.title }).closest('tr');
    const target = screen.getByRole('button', { name: FOLDER.title }).closest('tr');
    if (source === null || target === null) throw new Error('Drive rows must be table rows.');
    const dataTransfer = { effectAllowed: '', setData: vi.fn() };

    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await vi.waitFor(() => {
      expect(moveMock).toHaveBeenCalledTimes(2);
    });
    expect(moveMock).toHaveBeenCalledWith(NOTE.id, FOLDER.id, null);
    expect(moveMock).toHaveBeenCalledWith(FILE_A.id, FOLDER.id, null);
  });

  it('uploads files chosen through the Upload button, for a device with no drag-and-drop', async () => {
    render(driveOf({ items: [NOTE] }));

    const file = new File(['hello'], 'picked.txt', { type: 'text/plain' });
    const input = screen.getByLabelText('Files to upload', { selector: 'input' });
    fireEvent.change(input, { target: { files: [file] } });

    await vi.waitFor(() => {
      expect(beginUploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE, parentId: null, fileName: 'picked.txt' }),
      );
    });
    expect(uploadAndCompleteFileMock).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });

  it('runs uploads through a bounded pool, never more than 3 at once', async () => {
    let active = 0;
    let peakActive = 0;
    uploadAndCompleteFileMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          setTimeout(() => {
            active -= 1;
            resolve({
              itemId: 'new',
              workspaceId: WORKSPACE,
              current: fileVersion('new-v1', 'new.txt', 3),
              versions: [],
            });
          }, 0);
        }),
    );
    render(driveOf({ items: [NOTE] }));

    const files = Array.from(
      { length: 6 },
      (_, index) => new File(['x'], `picked-${String(index)}.txt`, { type: 'text/plain' }),
    );
    const input = screen.getByLabelText('Files to upload', { selector: 'input' });
    fireEvent.change(input, { target: { files } });

    await vi.waitFor(() => {
      expect(uploadAndCompleteFileMock).toHaveBeenCalledTimes(6);
    });
    expect(peakActive).toBeLessThanOrEqual(3);
    expect(peakActive).toBeGreaterThan(1);
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });

  it('uploads OS files dropped onto the view into this container', async () => {
    const { container: root } = render(driveOf({ items: [NOTE] }));

    const region = root.firstElementChild;
    if (region === null) throw new Error('The drive rendered nothing to drop onto.');
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const dataTransfer = {
      files: [file],
      types: ['Files'],
      items: [{ kind: 'file' }],
    };

    fireEvent.drop(region, { dataTransfer });

    await vi.waitFor(() => {
      expect(beginUploadMock).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE, parentId: null, fileName: 'hello.txt' }),
      );
    });
    expect(uploadAndCompleteFileMock).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(reloadMock).toHaveBeenCalled();
    });
  });
});
