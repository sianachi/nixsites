import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientProvider } from '@nix/web-platform/api/api-client-provider';
import { AuthProvider } from '@nix/web-platform/auth/auth-provider';
import { WorkspaceSidebar } from '../../items/workspace-sidebar';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';
import { WorkspaceProvider } from '@nix/web-workspaces/workspaces/workspace-context';
import { STUB_WORKSPACE } from '@nix/web-foundation/testing/api-stub';

/** Dropping files and folders from the OS onto the Explorer uploads them under the row's item. */

const calls = vi.hoisted(() => ({
  execute: [] as { operation: string; body: Record<string, unknown> }[],
}));

vi.mock('@nix/web-platform/api/api-client-provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiClient: () => ({
    cache: { subscribeInvalidation: () => () => undefined },
    query: () => new Promise(() => undefined),
    execute: (endpoint: { operation: string; body: Record<string, unknown> }) => {
      calls.execute.push(endpoint);
      return Promise.resolve(endpoint.operation === 'items.create' ? { id: 'folder-id' } : {});
    },
  }),
}));

vi.mock('@nix/api-client', async (importOriginal) => {
  const actual = await importOriginal<{ files: object }>();
  return {
    ...actual,
    files: { ...actual.files, uploadAndCompleteFile: () => Promise.resolve({}) },
  };
});

const ROOT_A: TreeItem = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  title: 'First',
  type: 'note',
  parentId: null,
  hasChildren: false,
  seq: 1000,
  lifecycleState: 'active',
};

function treeOf(items: readonly TreeItem[] = [ROOT_A]): WorkspaceTree {
  return {
    status: 'ready',
    error: null,
    items,
    isCreating: false,
    find: (id: string) => items.find((item) => item.id === id) ?? null,
    childrenOf: (parentId: string | null) => items.filter((item) => item.parentId === parentId),
    breadcrumbs: () => [],
    isExpanded: () => false,
    isLoadingChildren: () => false,
    isLocked: () => false,
    toggle: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    create: () => Promise.resolve(null),
    rename: () => Promise.resolve(),
    move: () => Promise.resolve({ refusal: null }),
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  } as unknown as WorkspaceTree;
}

function renderSidebar(tree: WorkspaceTree): void {
  render(
    <MemoryRouter initialEntries={[`/w/${STUB_WORKSPACE.id}`]}>
      <AuthProvider>
        <ApiClientProvider>
          <Routes>
            <Route
              path="/w/:workspaceId"
              element={
                <WorkspaceProvider
                  state={{
                    status: 'ready',
                    workspaces: [STUB_WORKSPACE],
                    error: null,
                    reload: () => undefined,
                    workspaceCreated: () => undefined,
                    workspaceUpdated: () => undefined,
                    workspaceRemoved: () => undefined,
                  }}
                >
                  <WorkspaceSidebar
                    tree={tree}
                    selectedId={null}
                    onSelect={vi.fn()}
                    onOpenBeside={() => undefined}
                    onOpenPinned={() => undefined}
                    besideRefusal={null}
                    canOpenBeside
                    onDeleteItem={vi.fn()}
                    treeRegionRef={{ current: null }}
                  />
                </WorkspaceProvider>
              }
            />
          </Routes>
        </ApiClientProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const fileEntry = (file: File): FileSystemFileEntry =>
  ({
    isFile: true,
    isDirectory: false,
    name: file.name,
    file: (ok: (f: File) => void) => {
      ok(file);
    },
  }) as never;

const dirEntry = (name: string, children: FileSystemEntry[]): FileSystemDirectoryEntry =>
  ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      const batches = [children, []];
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          ok(batches.shift() ?? []);
        },
      };
    },
  }) as never;

const dropOf = (entry: FileSystemEntry) => ({
  types: ['Files'],
  items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }],
});

describe('dropping OS files on the Explorer', () => {
  it('uploads a file dropped on a row into that row', async () => {
    calls.execute.length = 0;
    renderSidebar(treeOf());
    const row = screen.getByRole('button', { name: 'First' }).parentElement;
    if (row === null) throw new Error('no row');
    const dataTransfer = dropOf(fileEntry(new File(['x'], 'a.txt', { type: 'text/plain' })));
    fireEvent.dragOver(row, { dataTransfer }); // no layout in jsdom: the zone is "inside"
    fireEvent.drop(row, { dataTransfer });
    await waitFor(() => {
      expect(calls.execute.map((c) => c.operation)).toContain('files.upload.begin');
    });
    expect(calls.execute.find((c) => c.operation === 'files.upload.begin')?.body).toMatchObject({
      parentId: ROOT_A.id,
      fileName: 'a.txt',
    });
  });

  it('creates a note for a dropped folder and uploads its child under it', async () => {
    calls.execute.length = 0;
    renderSidebar(treeOf());
    const aside = screen.getByRole('complementary', { name: 'Explorer' });
    const folder = dirEntry('Docs', [fileEntry(new File(['x'], 'b.txt'))]);
    fireEvent.drop(aside, { dataTransfer: dropOf(folder) });
    await waitFor(() => {
      expect(calls.execute.map((c) => c.operation)).toContain('files.upload.begin');
    });
    expect(calls.execute[0]?.body).toMatchObject({ type: 'note', title: 'Docs', parentId: null });
    expect(calls.execute[1]?.body).toMatchObject({ parentId: 'folder-id', fileName: 'b.txt' });
  });
});
