import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type {
  FileId,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  LibraryItem,
  LibraryItems,
} from '@excalidraw/excalidraw/types';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasElement } from '../../editor/canvas-binding';
import { NixCanvas, type NixCanvasProps } from '../../editor/nix-canvas';

type SceneUpdate = Parameters<ExcalidrawImperativeAPI['updateScene']>[0];

interface BeginUploadInput {
  readonly workspaceId: string;
  readonly parentId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly idempotencyKey: string;
}

const excalidrawHarness = vi.hoisted(() => {
  const state = {
    props: null as ExcalidrawProps | null,
    scene: [] as readonly OrderedExcalidrawElement[],
    files: {} as BinaryFiles,
    appState: {} as AppState,
  };
  const updateScene = vi.fn((update: SceneUpdate): void => {
    if (update.elements !== undefined) {
      state.scene = update.elements as readonly OrderedExcalidrawElement[];
    }
  });
  const addFiles = vi.fn((files: readonly BinaryFileData[]): void => {
    state.files = {
      ...state.files,
      ...Object.fromEntries(files.map((file) => [file.id, file])),
    };
  });
  const updateLibrary = vi.fn(
    (options: { readonly libraryItems: LibraryItems; readonly merge?: boolean }) =>
      Promise.resolve(options.libraryItems),
  );
  const api = {
    updateScene,
    addFiles,
    updateLibrary,
    getSceneElementsIncludingDeleted: vi.fn(() => state.scene),
    getFiles: vi.fn(() => state.files),
    getAppState: vi.fn(() => state.appState),
    scrollToContent: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;

  return {
    state,
    api,
    updateScene,
    addFiles,
    updateLibrary,
    reconcileElements: vi.fn(
      (
        _current: readonly OrderedExcalidrawElement[],
        incoming: readonly OrderedExcalidrawElement[],
        state?: AppState,
      ) => {
        void state;
        return incoming;
      },
    ),
    getDataURL: vi.fn((blob: Blob) => {
      void blob;
      return Promise.resolve('data:image/png;base64,bml4');
    }),
    viewportCoordsToSceneCoords: vi.fn(
      ({ clientX, clientY }: { readonly clientX: number; readonly clientY: number }) => ({
        x: clientX,
        y: clientY,
      }),
    ),
    loadFromBlob: vi.fn(),
  };
});

const libraryHarness = vi.hoisted(() => ({
  current: {
    status: 'ready',
    items: [] as readonly unknown[],
    save: vi.fn<(items: readonly unknown[]) => void>(),
  },
}));

const fileHarness = vi.hoisted(() => ({
  beginUpload: vi.fn((input: BeginUploadInput) => ({ operation: 'begin-upload', input })),
  deleteItem: vi.fn((workspaceId: string, itemId: string) => ({
    operation: 'delete-item',
    workspaceId,
    itemId,
  })),
  uploadAndCompleteFile: vi.fn(),
  fetchFileContent: vi.fn(),
  listItems: vi.fn(),
  searchItems: vi.fn(),
  client: {
    execute: vi.fn<(endpoint: unknown) => Promise<unknown>>(),
    paginate: vi.fn(),
    query: vi.fn<(endpoint: unknown) => Promise<unknown>>(),
  },
}));

vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');

  function MockExcalidraw(props: ExcalidrawProps): React.ReactNode {
    excalidrawHarness.state.props = props;
    const { excalidrawAPI } = props;
    React.useEffect(() => {
      excalidrawAPI?.(excalidrawHarness.api);
    }, [excalidrawAPI]);
    return React.createElement(
      'div',
      { 'data-testid': 'mock-excalidraw', className: 'excalidraw' },
      props.renderTopRightUI?.(false, excalidrawHarness.state.appState),
      React.createElement('button', { className: 'main-menu-trigger', type: 'button' }),
      React.createElement('footer', { role: 'contentinfo' }),
    );
  }

  return {
    CaptureUpdateAction: { NEVER: 'never', IMMEDIATELY: 'immediately' },
    Excalidraw: MockExcalidraw,
    restoreElements: vi.fn((elements: readonly OrderedExcalidrawElement[]) => elements),
    reconcileElements: excalidrawHarness.reconcileElements,
    getDataURL: excalidrawHarness.getDataURL,
    viewportCoordsToSceneCoords: excalidrawHarness.viewportCoordsToSceneCoords,
    loadFromBlob: excalidrawHarness.loadFromBlob,
    convertToExcalidrawElements: vi.fn((elements: readonly OrderedExcalidrawElement[]) => elements),
    newElementWith: vi.fn(
      (element: OrderedExcalidrawElement, changes: Readonly<Record<string, unknown>>) => ({
        ...element,
        ...changes,
        version: element.version + 1,
      }),
    ),
  };
});

vi.mock('@nix/api-client', () => ({
  files: {
    beginUpload: fileHarness.beginUpload,
    uploadAndCompleteFile: fileHarness.uploadAndCompleteFile,
    fetchFileContent: fileHarness.fetchFileContent,
  },
  items: { deleteItem: fileHarness.deleteItem, listItems: fileHarness.listItems },
  search: { searchItems: fileHarness.searchItems },
}));

vi.mock('@nix/web-platform/api/api-client-provider', () => ({
  useApiClient: () => fileHarness.client,
}));

vi.mock('../../editor/use-canvas-library', () => ({
  useCanvasLibrary: () => libraryHarness.current,
}));

function appState(overrides: Readonly<Record<string, unknown>> = {}): AppState {
  return {
    editingTextElement: null,
    newElement: null,
    resizingElement: null,
    selectedElementIds: {},
    zoom: { value: 1 },
    width: 800,
    height: 600,
    scrollX: 0,
    scrollY: 0,
    currentItemStrokeColor: 'CanvasText',
    currentItemBackgroundColor: 'transparent',
    currentItemFillStyle: 'solid',
    currentItemStrokeWidth: 2,
    currentItemStrokeStyle: 'solid',
    currentItemRoughness: 1,
    currentItemOpacity: 100,
    ...overrides,
  } as unknown as AppState;
}

function sceneElement(overrides: Readonly<Record<string, unknown>> = {}): OrderedExcalidrawElement {
  return {
    id: 'shape-1',
    type: 'rectangle',
    version: 1,
    versionNonce: 7,
    index: 'a0',
    isDeleted: false,
    x: 10,
    y: 20,
    width: 80,
    height: 40,
    strokeColor: 'CanvasText',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    angle: 0,
    seed: 1,
    groupIds: [],
    ...overrides,
  } as unknown as OrderedExcalidrawElement;
}

function libraryItem(id: string): LibraryItem {
  return {
    id,
    status: 'unpublished',
    created: 123,
    elements: [sceneElement()] as readonly NonDeletedExcalidrawElement[],
  };
}

function currentExcalidrawProps(): ExcalidrawProps {
  const props = excalidrawHarness.state.props;
  if (props === null) throw new Error('The mocked Excalidraw editor has not rendered.');
  return props;
}

async function renderCanvas(
  props: Partial<NixCanvasProps> = {},
): Promise<ReturnType<typeof render>> {
  const view = render(
    <NixCanvas
      elements={[]}
      onChange={() => undefined}
      workspaceId="10000000-0000-4000-8000-000000000001"
      parentItemId="20000000-0000-4000-8000-000000000002"
      {...props}
    />,
  );
  await waitFor(() => {
    expect(excalidrawHarness.updateLibrary).toHaveBeenCalledTimes(1);
  });
  return view;
}

describe('the Excalidraw canvas integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    excalidrawHarness.state.props = null;
    excalidrawHarness.state.scene = [];
    excalidrawHarness.state.files = {};
    excalidrawHarness.state.appState = appState();
    excalidrawHarness.reconcileElements.mockImplementation(
      (
        _current: readonly OrderedExcalidrawElement[],
        incoming: readonly OrderedExcalidrawElement[],
      ) => incoming,
    );
    libraryHarness.current.status = 'ready';
    libraryHarness.current.items = [];
    libraryHarness.current.save = vi.fn();
    fileHarness.client.execute.mockResolvedValue({ id: 'upload-1' });
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: '30000000-0000-4000-8000-000000000003',
      current: { previewable: true },
    });
    fileHarness.fetchFileContent.mockResolvedValue({
      blob: new Blob(['nix'], { type: 'image/png' }),
      capability: { mediaType: 'image/png' },
    });
    document.documentElement.setAttribute('data-theme', 'light');
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
  });

  it('keeps desktop actions visible and groups narrow canvas actions in one menu', async () => {
    fileHarness.client.paginate.mockImplementation(function* () {
      yield { id: 'release-plan', title: 'Release plan' };
    });
    await renderCanvas();
    const item = screen.getByRole('button', { name: 'Add a Nix item to the canvas' });
    expect(item).toHaveTextContent('Nix item');
    expect(item).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(item.parentElement).toHaveClass('shrink-0');
    const mobile = render(
      <>{currentExcalidrawProps().renderTopRightUI?.(true, excalidrawHarness.state.appState)}</>,
    );
    expect(mobile.container).not.toHaveTextContent('Nix item');
    fireEvent.click(screen.getByRole('button', { name: 'Canvas actions' }));
    expect(
      screen.getByRole('menuitem', { name: 'Import an Excalidraw scene' }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a Nix item to the canvas' }));
    expect(screen.getByRole('dialog', { name: 'Add a Nix item' })).toBeInTheDocument();
  });

  it('names native canvas controls without introducing a page-footer landmark', async () => {
    await renderCanvas();
    expect(screen.getByRole('button', { name: 'Canvas menu' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Canvas view controls' })).toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText('Import an Excalidraw scene', { selector: 'input' }),
    ).toHaveAttribute('type', 'file');
  });

  it('flags the "Add a Nix item" list as cut off, and narrows it by search once three letters are typed', async () => {
    fileHarness.client.paginate.mockImplementation(function* () {
      for (let index = 0; index < 100; index += 1) {
        yield { id: `item-${String(index)}`, title: `Item ${String(index)}` };
      }
    });
    fileHarness.client.query.mockResolvedValue({
      query: 'roadmap',
      results: [
        {
          id: 'match-1',
          workspaceId: '10000000-0000-4000-8000-000000000001',
          type: 'note',
          title: 'Quarterly roadmap',
        },
      ],
      limit: 100,
      truncated: false,
    });

    await renderCanvas();
    fireEvent.click(screen.getByRole('button', { name: 'Add a Nix item to the canvas' }));

    // The first page is exactly the request's own cap - a hundred items is what "cut off"
    // looks like here, not a round number the workspace happens to have.
    expect(
      await screen.findByText(
        'Showing the first 100 items. Type to search the rest of the workspace.',
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter items' }), {
      target: { value: 'roadmap' },
    });

    await waitFor(() => {
      expect(fileHarness.client.query).toHaveBeenCalled();
    });
    expect(await screen.findByRole('option', { name: 'Quarterly roadmap' })).toBeInTheDocument();
    // The unfiltered notice is about the unfiltered list, and a search that came back complete
    // has nothing left to warn about.
    expect(screen.queryByText(/Showing the first 100 items/)).not.toBeInTheDocument();
  });

  it('applies Nix UI policy and makes read-only mode genuinely non-editable', async () => {
    const view = await renderCanvas({ readOnly: true });

    let props = currentExcalidrawProps();
    expect(screen.getByRole('region', { name: 'Canvas workspace' })).toBeInTheDocument();
    expect(screen.getByText('Canvas is read only.')).toBeInTheDocument();
    expect(props).toMatchObject({
      theme: 'light',
      viewModeEnabled: true,
      isCollaborating: false,
      handleKeyboardGlobally: false,
      aiEnabled: false,
      validateEmbeddable: false,
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          changeViewBackgroundColor: false,
          toggleTheme: false,
          clearCanvas: false,
        },
        tools: { image: false },
      },
    });
    expect(props.generateIdForFile).toBeUndefined();
    expect(props.renderTopRightUI?.(false, excalidrawHarness.state.appState)).toBeNull();

    view.rerender(
      <NixCanvas
        elements={[]}
        onChange={() => undefined}
        workspaceId="10000000-0000-4000-8000-000000000001"
        parentItemId="20000000-0000-4000-8000-000000000002"
      />,
    );
    props = currentExcalidrawProps();
    expect(props.viewModeEnabled).toBe(false);
    expect(props.UIOptions?.canvasActions?.clearCanvas).toBe(true);
    expect(props.UIOptions?.tools?.image).toBe(true);
    expect(props.generateIdForFile).toBeTypeOf('function');
  });

  it('publishes a local scene once and ignores Excalidraw repeats', async () => {
    const onChange = vi.fn();
    await renderCanvas({ onChange });
    excalidrawHarness.updateScene.mockClear();
    const local = [sceneElement()];

    act(() => {
      currentExcalidrawProps().onChange?.(local, appState(), {});
      currentExcalidrawProps().onChange?.(local, appState(), {});
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(local);
    expect(excalidrawHarness.updateScene).not.toHaveBeenCalled();
  });

  it('reconciles remote elements outside undo and suppresses their Excalidraw echo', async () => {
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });
    excalidrawHarness.updateScene.mockClear();
    excalidrawHarness.reconcileElements.mockClear();
    const remote = [sceneElement({ id: 'remote-shape', version: 4, versionNonce: 3 })];

    view.rerender(
      <NixCanvas
        elements={remote}
        onChange={onChange}
        workspaceId="10000000-0000-4000-8000-000000000001"
        parentItemId="20000000-0000-4000-8000-000000000002"
      />,
    );

    await waitFor(() => {
      expect(excalidrawHarness.reconcileElements).toHaveBeenCalledTimes(1);
    });
    const remoteUpdate = excalidrawHarness.updateScene.mock.calls.find(
      ([update]) => update.elements !== undefined,
    )?.[0];
    expect(remoteUpdate?.elements).toEqual(remote);
    expect(remoteUpdate?.captureUpdate).toBe(CaptureUpdateAction.NEVER);
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      currentExcalidrawProps().onChange?.(remote, appState(), {});
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not republish an older local element retained only for an active gesture', async () => {
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });
    const local = sceneElement({ id: 'shared-shape', version: 2, versionNonce: 8, x: 20 });
    const remote = sceneElement({ id: 'shared-shape', version: 3, versionNonce: 7, x: 90 });
    excalidrawHarness.state.scene = [local];
    excalidrawHarness.state.appState = appState({ resizingElement: local });
    excalidrawHarness.reconcileElements.mockImplementation(
      (
        current: readonly OrderedExcalidrawElement[],
        incoming: readonly OrderedExcalidrawElement[],
        state?: AppState,
      ) => (state?.resizingElement === null ? incoming : current),
    );
    excalidrawHarness.updateScene.mockClear();

    view.rerender(
      <NixCanvas
        elements={[remote]}
        onChange={onChange}
        workspaceId="10000000-0000-4000-8000-000000000001"
        parentItemId="20000000-0000-4000-8000-000000000002"
      />,
    );

    await waitFor(() => {
      expect(excalidrawHarness.updateScene).toHaveBeenCalledWith({
        elements: [local],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    expect(onChange).not.toHaveBeenCalled();

    excalidrawHarness.state.appState = appState();
    act(() => {
      currentExcalidrawProps().onChange?.([local], excalidrawHarness.state.appState, {});
    });

    expect(excalidrawHarness.updateScene).toHaveBeenLastCalledWith({
      elements: [remote],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps reconciled z-order when a newer local element has moved above remote elements', async () => {
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });
    const old = sceneElement({ id: 'moved', index: 'a0' });
    const other = sceneElement({ id: 'other', index: 'a1' });
    const moved = sceneElement({
      ...old,
      version: old.version + 1,
      index: 'a2',
    });
    excalidrawHarness.state.scene = [other, moved];
    excalidrawHarness.reconcileElements.mockReturnValue([other, moved]);
    view.rerender(
      <NixCanvas
        elements={[old, other]}
        onChange={onChange}
        workspaceId="10000000-0000-4000-8000-000000000001"
        parentItemId="20000000-0000-4000-8000-000000000002"
      />,
    );
    expect(onChange).toHaveBeenCalledExactlyOnceWith([other, moved]);
    act(() => {
      currentExcalidrawProps().onChange?.([other, moved], appState(), {});
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('seeds the personal library exactly once and saves later library changes', async () => {
    const first = libraryItem('library-1');
    libraryHarness.current.items = [first];
    const view = await renderCanvas();

    expect(excalidrawHarness.updateLibrary).toHaveBeenCalledWith({
      libraryItems: [first],
      merge: false,
    });

    const second = libraryItem('library-2');
    libraryHarness.current.items = [second];
    view.rerender(
      <NixCanvas
        elements={[sceneElement({ id: 'rerender' })]}
        onChange={() => undefined}
        workspaceId="10000000-0000-4000-8000-000000000001"
        parentItemId="20000000-0000-4000-8000-000000000002"
      />,
    );
    expect(excalidrawHarness.updateLibrary).toHaveBeenCalledTimes(1);

    act(() => {
      void currentExcalidrawProps().onLibraryChange?.([second]);
    });
    expect(libraryHarness.current.save).toHaveBeenCalledWith([second]);
  });

  it('intercepts Nix item links and delegates navigation to the host', async () => {
    const onOpenItem = vi.fn();
    await renderCanvas({ onOpenItem });
    const linked = sceneElement({
      customData: { nix: { kind: 'item', itemId: 'linked-item' } },
      link: 'nix://item/linked-item',
    }) as NonDeletedExcalidrawElement;
    const event = new CustomEvent('link-open', {
      detail: { nativeEvent: new MouseEvent('click') },
    });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    act(() => {
      currentExcalidrawProps().onLinkOpen?.(linked, event);
    });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenItem).toHaveBeenCalledWith('linked-item');
  });

  it('uploads an inserted image as a child file and returns its durable item ID', async () => {
    await renderCanvas();
    const upload = currentExcalidrawProps().generateIdForFile;
    if (upload === undefined) throw new Error('Writable canvases must expose image upload.');
    const file = new File(['image'], 'plan.png', { type: 'image/png' });

    let fileId: string | undefined;
    await act(async () => {
      fileId = await upload(file);
    });

    expect(fileId).toBe('30000000-0000-4000-8000-000000000003');
    const [input] = fileHarness.beginUpload.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      workspaceId: '10000000-0000-4000-8000-000000000001',
      parentId: '20000000-0000-4000-8000-000000000002',
      fileName: 'plan.png',
      mediaType: 'image/png',
      byteLength: file.size,
    });
    expect(input?.idempotencyKey).toMatch(/^web-canvas-image:/u);
    expect(fileHarness.uploadAndCompleteFile).toHaveBeenCalledWith(
      fileHarness.client,
      { id: 'upload-1' },
      file,
      expect.any(AbortSignal),
    );
  });

  it('retires a native image upload if the canvas closes before Excalidraw inserts it', async () => {
    const fileId = '30000000-0000-4000-8000-000000000003';
    const view = await renderCanvas();
    const upload = currentExcalidrawProps().generateIdForFile;
    if (upload === undefined) throw new Error('Writable canvases must expose image upload.');

    await act(async () => {
      await upload(new File(['image'], 'plan.png', { type: 'image/png' }));
    });
    expect(fileHarness.deleteItem).not.toHaveBeenCalled();

    view.unmount();

    await waitFor(() => {
      expect(fileHarness.deleteItem).toHaveBeenCalledWith(
        '10000000-0000-4000-8000-000000000001',
        fileId,
      );
    });
  });

  it('rejects image formats that Core cannot preview again after reload', async () => {
    await renderCanvas();
    const upload = currentExcalidrawProps().generateIdForFile;
    if (upload === undefined) throw new Error('Writable canvases must expose image upload.');

    await act(async () => {
      await expect(
        upload(new File(['svg'], 'diagram.svg', { type: 'image/svg+xml' })),
      ).rejects.toThrow('Canvas images must be PNG, JPEG, WebP, or AVIF files.');
    });

    expect(fileHarness.beginUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Canvas images must be PNG, JPEG, WebP, or AVIF files.',
    );
  });

  it('keeps upload feedback live after the application Strict Mode probe', async () => {
    render(
      <StrictMode>
        <NixCanvas
          elements={[]}
          onChange={() => undefined}
          workspaceId="10000000-0000-4000-8000-000000000001"
          parentItemId="20000000-0000-4000-8000-000000000002"
        />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(currentExcalidrawProps().generateIdForFile).toBeTypeOf('function');
    });
    const upload = currentExcalidrawProps().generateIdForFile;
    if (upload === undefined) throw new Error('Writable canvases must expose image upload.');

    await act(async () => {
      await expect(
        upload(new File(['svg'], 'diagram.svg', { type: 'image/svg+xml' })),
      ).rejects.toThrow('Canvas images must be PNG, JPEG, WebP, or AVIF files.');
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Canvas images must be PNG, JPEG, WebP, or AVIF files.',
    );
  });

  it('does not insert a file that server inspection found non-previewable', async () => {
    fileHarness.uploadAndCompleteFile.mockResolvedValue({
      itemId: '30000000-0000-4000-8000-000000000003',
      current: { previewable: false },
    });
    await renderCanvas();
    const upload = currentExcalidrawProps().generateIdForFile;
    if (upload === undefined) throw new Error('Writable canvases must expose image upload.');

    await act(async () => {
      await expect(upload(new File(['png'], 'picture.png', { type: 'image/png' }))).rejects.toThrow(
        'Nix could not verify this file as a durable, previewable image.',
      );
    });

    expect(fileHarness.uploadAndCompleteFile).toHaveBeenCalledOnce();
    expect(fileHarness.deleteItem).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003',
    );
    expect(fileHarness.client.execute).toHaveBeenCalledWith({
      operation: 'delete-item',
      workspaceId: '10000000-0000-4000-8000-000000000001',
      itemId: '30000000-0000-4000-8000-000000000003',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Nix could not verify this file as a durable, previewable image.',
    );
  });

  it('retires every child file created before a multi-image import fails', async () => {
    const firstFileId = '30000000-0000-4000-8000-000000000003';
    const rejectedFileId = '40000000-0000-4000-8000-000000000004';
    const firstImage = sceneElement({
      id: 'image-1',
      type: 'image',
      fileId: 'embedded-image-1',
      status: 'saved',
    });
    const secondImage = sceneElement({
      id: 'image-2',
      type: 'image',
      fileId: 'embedded-image-2',
      status: 'saved',
    });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [firstImage, secondImage],
      appState: appState(),
      files: {
        'embedded-image-1': {
          id: 'embedded-image-1',
          dataURL: 'data:image/png;base64,bml4',
          mimeType: 'image/png',
          created: 1,
        },
        'embedded-image-2': {
          id: 'embedded-image-2',
          dataURL: 'data:image/png;base64,bml4',
          mimeType: 'image/png',
          created: 2,
        },
      },
    });
    fileHarness.uploadAndCompleteFile
      .mockResolvedValueOnce({
        itemId: firstFileId,
        current: { previewable: true },
      })
      .mockResolvedValueOnce({
        itemId: rejectedFileId,
        current: { previewable: false },
      });
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: { files: [new File(['scene'], 'plan.excalidraw', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'Nix could not verify this file as a durable, previewable image.',
      );
    });
    expect(fileHarness.deleteItem).toHaveBeenCalledTimes(2);
    expect(fileHarness.deleteItem).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      rejectedFileId,
    );
    expect(fileHarness.deleteItem).toHaveBeenCalledWith(
      '10000000-0000-4000-8000-000000000001',
      firstFileId,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(excalidrawHarness.updateScene).not.toHaveBeenCalledWith(
      expect.objectContaining({ captureUpdate: CaptureUpdateAction.IMMEDIATELY }),
    );
  });

  it('hydrates durable image IDs through preview capabilities without persisting bytes', async () => {
    const fileId = '30000000-0000-4000-8000-000000000003';
    const image = sceneElement({
      id: 'image-1',
      type: 'image',
      fileId,
      status: 'saved',
      customData: { nix: { kind: 'file', itemId: fileId } },
    });
    const onChange = vi.fn();

    await renderCanvas({ elements: [image], onChange });

    await waitFor(() => {
      expect(excalidrawHarness.addFiles).toHaveBeenCalledTimes(1);
    });
    const fetchCall = fileHarness.fetchFileContent.mock.calls[0];
    expect(fetchCall?.slice(0, 4)).toEqual([fileHarness.client, fileId, undefined, true]);
    expect(fetchCall?.[4]).toBeInstanceOf(AbortSignal);
    const [loaded] = excalidrawHarness.addFiles.mock.calls[0] ?? [];
    expect(loaded).toEqual([
      expect.objectContaining({
        id: fileId,
        dataURL: 'data:image/png;base64,bml4',
        mimeType: 'image/png',
      }),
    ]);
    expect(JSON.stringify(currentExcalidrawProps().initialData)).not.toContain('data:image/png');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('imports embedded images without fetch and durably retires the replaced scene', async () => {
    const durableFileId = '30000000-0000-4000-8000-000000000003';
    const old = sceneElement({ id: 'old-shape', version: 4 });
    const collision = sceneElement({ id: 'same-id', version: 7, type: 'rectangle' });
    const importedCollision = sceneElement({ id: 'same-id', version: 1, type: 'ellipse' });
    const importedImage = sceneElement({
      id: 'image-1',
      type: 'image',
      fileId: 'embedded-image',
      status: 'saved',
    });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [importedCollision, importedImage],
      appState: appState(),
      files: {
        'embedded-image': {
          id: 'embedded-image',
          dataURL: 'data:image/png;base64,bml4',
          mimeType: 'image/png',
          created: 1,
        },
      },
    });
    const browserFetch = vi.fn(() =>
      Promise.reject(new Error('A data URL must not be fetched under the production CSP.')),
    );
    vi.stubGlobal('fetch', browserFetch);
    const publishedScenes: (readonly CanvasElement[])[] = [];
    const onChange = vi.fn((next: readonly CanvasElement[]) => {
      publishedScenes.push(next);
    });
    const view = await renderCanvas({ onChange });
    excalidrawHarness.state.scene = [old, collision];
    excalidrawHarness.updateScene.mockClear();

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: { files: [new File(['scene'], 'plan.excalidraw', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    const next = publishedScenes[0];
    if (next === undefined) throw new Error('Expected the imported scene to be published.');
    expect(next).toEqual([
      expect.objectContaining({ id: 'old-shape', isDeleted: true, version: 5 }),
      expect.objectContaining({ id: 'same-id', type: 'ellipse', version: 8 }),
      expect.objectContaining({
        id: 'image-1',
        fileId: durableFileId,
        customData: { nix: { kind: 'file', itemId: durableFileId } },
      }),
    ]);
    expect(browserFetch).not.toHaveBeenCalled();
    const uploadedFile: unknown = fileHarness.uploadAndCompleteFile.mock.calls[0]?.[2];
    expect(uploadedFile).toBeInstanceOf(File);
    expect(uploadedFile).toMatchObject({ type: 'image/png', size: 3 });
    expect(excalidrawHarness.updateScene).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: next,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
  });

  it('keeps image-free scene import available when the canvas cannot own files', async () => {
    const importedShape = sceneElement({ id: 'imported-shape', type: 'ellipse' });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [importedShape],
      appState: appState(),
      files: {},
    });
    const onChange = vi.fn();
    const view = await renderCanvas({ allowFileUploads: false, onChange });
    const props = currentExcalidrawProps();

    expect(props.UIOptions?.tools?.image).toBe(false);
    expect(props.generateIdForFile).toBeUndefined();
    expect(
      screen.getByRole('button', { name: 'Import an Excalidraw scene without images' }),
    ).toHaveTextContent('Import shapes');
    expect(
      screen.getByRole('button', { name: 'Import an Excalidraw scene without images' }),
    ).toHaveAttribute('title', 'This canvas can import shapes and text, but not images.');

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: { files: [new File(['scene'], 'shapes.excalidraw', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([importedShape]);
    });
    expect(fileHarness.uploadAndCompleteFile).not.toHaveBeenCalled();
  });

  it('refuses an image-bearing import when the canvas cannot own files', async () => {
    const importedImage = sceneElement({
      id: 'image-1',
      type: 'image',
      fileId: 'embedded-image',
      status: 'saved',
    });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [importedImage],
      appState: appState(),
      files: {
        'embedded-image': {
          id: 'embedded-image',
          dataURL: 'data:image/png;base64,bml4',
          mimeType: 'image/png',
          created: 1,
        },
      },
    });
    const onChange = vi.fn();
    const view = await renderCanvas({ allowFileUploads: false, onChange });
    excalidrawHarness.updateScene.mockClear();

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: { files: [new File(['scene'], 'images.excalidraw', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'This scene contains images, but this canvas cannot own uploaded files.',
      );
    });
    expect(fileHarness.beginUpload).not.toHaveBeenCalled();
    expect(fileHarness.uploadAndCompleteFile).not.toHaveBeenCalled();
    expect(excalidrawHarness.updateScene).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uploads and remaps images from the structured Excalidraw clipboard', async () => {
    const durableFileId = '30000000-0000-4000-8000-000000000003' as FileId;
    const clipboardFileId = 'clipboard-file' as FileId;
    const clipboardImage = sceneElement({
      id: 'clipboard-image',
      type: 'image',
      fileId: clipboardFileId,
      status: 'saved',
    });
    const clipboard: Parameters<NonNullable<ExcalidrawProps['onPaste']>>[0] = {
      elements: [clipboardImage],
      files: {
        [clipboardFileId]: {
          id: clipboardFileId,
          dataURL: 'data:image/png;base64,bml4' as DataURL,
          mimeType: 'image/png',
          created: 1,
        },
      },
    };
    await renderCanvas();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await currentExcalidrawProps().onPaste?.(clipboard, null);
    });

    expect(accepted).toBe(true);
    expect(clipboard.elements).toEqual([
      expect.objectContaining({
        id: 'clipboard-image',
        fileId: durableFileId,
        status: 'saved',
        customData: { nix: { kind: 'file', itemId: durableFileId } },
      }),
    ]);
    const pastedFile = clipboard.files?.[durableFileId];
    expect(pastedFile?.id).toBe(durableFileId);
    expect(pastedFile?.mimeType).toBe('image/png');
  });

  it('blocks structured image paste when the canvas cannot own files', async () => {
    const clipboardFileId = 'clipboard-file' as FileId;
    const clipboardImage = sceneElement({
      id: 'clipboard-image',
      type: 'image',
      fileId: clipboardFileId,
      status: 'saved',
    });
    await renderCanvas({ allowFileUploads: false });

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await currentExcalidrawProps().onPaste?.(
        {
          elements: [clipboardImage],
          files: {
            [clipboardFileId]: {
              id: clipboardFileId,
              dataURL: 'data:image/png;base64,bml4' as DataURL,
              mimeType: 'image/png',
              created: 1,
            },
          },
        },
        null,
      );
    });

    expect(accepted).toBe(false);
    expect(fileHarness.beginUpload).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'This canvas can paste shapes and text, but not images.',
    );
  });

  it('retries a failed retirement instead of losing the pending file ID', async () => {
    const firstFileId = '30000000-0000-4000-8000-000000000003' as FileId;
    const firstImage = sceneElement({
      id: 'first-image',
      type: 'image',
      fileId: 'clipboard-file-1',
      status: 'saved',
    });
    const secondImage = sceneElement({
      id: 'second-image',
      type: 'image',
      fileId: 'clipboard-file-2',
      status: 'saved',
    });
    let firstDelete = true;
    fileHarness.client.execute.mockImplementation((endpoint: unknown) => {
      if (
        typeof endpoint === 'object' &&
        endpoint !== null &&
        'operation' in endpoint &&
        endpoint.operation === 'delete-item' &&
        firstDelete
      ) {
        firstDelete = false;
        return Promise.reject(new Error('temporary delete failure'));
      }
      return Promise.resolve({ id: 'upload-1' });
    });
    await renderCanvas();

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await currentExcalidrawProps().onPaste?.(
        {
          elements: [firstImage, secondImage],
          files: {
            'clipboard-file-1': {
              id: 'clipboard-file-1' as FileId,
              dataURL: 'data:image/png;base64,bml4' as DataURL,
              mimeType: 'image/png',
              created: 1,
            },
          },
        },
        null,
      );
    });

    expect(accepted).toBe(false);
    expect(fileHarness.deleteItem).toHaveBeenCalledTimes(2);
    expect(fileHarness.deleteItem).toHaveBeenLastCalledWith(
      '10000000-0000-4000-8000-000000000001',
      firstFileId,
    );
  });

  it('rolls back image ingress that bypasses the upload and paste hooks', async () => {
    const memoryOnlyFileId = 'memory-only-file' as FileId;
    const safe = sceneElement({ id: 'safe-shape' });
    const foreignImage = sceneElement({
      id: 'foreign-image',
      type: 'image',
      fileId: memoryOnlyFileId,
      status: 'saved',
    });
    const onChange = vi.fn();
    await renderCanvas({ elements: [safe], onChange });
    excalidrawHarness.updateScene.mockClear();

    act(() => {
      currentExcalidrawProps().onChange?.([foreignImage], appState(), {
        [memoryOnlyFileId]: {
          id: memoryOnlyFileId,
          dataURL: 'data:image/png;base64,bml4' as DataURL,
          mimeType: 'image/png',
          created: 1,
        },
      });
    });

    expect(excalidrawHarness.updateScene).toHaveBeenCalledWith({
      elements: [safe],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Use Import for image-bearing Excalidraw scenes so Nix can store their images.',
    );
  });

  it('retires a completed import upload when the canvas unmounts before publication', async () => {
    const fileId = '30000000-0000-4000-8000-000000000003';
    let finishUpload: ((record: unknown) => void) | undefined;
    fileHarness.uploadAndCompleteFile.mockReturnValue(
      new Promise((resolve) => {
        finishUpload = resolve;
      }),
    );
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [
        sceneElement({
          id: 'image-1',
          type: 'image',
          fileId: 'embedded-image',
          status: 'saved',
        }),
      ],
      appState: appState(),
      files: {
        'embedded-image': {
          id: 'embedded-image',
          dataURL: 'data:image/png;base64,bml4',
          mimeType: 'image/png',
          created: 1,
        },
      },
    });
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: { files: [new File(['scene'], 'plan.excalidraw', { type: 'application/json' })] },
    });
    await waitFor(() => {
      expect(fileHarness.uploadAndCompleteFile).toHaveBeenCalledOnce();
    });

    view.unmount();
    finishUpload?.({ itemId: fileId, current: { previewable: true } });

    await waitFor(() => {
      expect(fileHarness.deleteItem).toHaveBeenCalledWith(
        '10000000-0000-4000-8000-000000000001',
        fileId,
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not treat an in-memory file-ID collision as a durable imported image', async () => {
    const collidingId = '30000000-0000-4000-8000-000000000003' as FileId;
    excalidrawHarness.state.files = {
      [collidingId]: {
        id: collidingId,
        dataURL: 'data:image/png;base64,bml4' as DataURL,
        mimeType: 'image/png',
        created: 1,
      },
    };
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [
        sceneElement({
          id: 'image-1',
          type: 'image',
          fileId: collidingId,
          status: 'saved',
        }),
      ],
      appState: appState(),
      files: {},
    });
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');
    fireEvent.change(input, {
      target: {
        files: [new File(['scene'], 'collision.excalidraw', { type: 'application/json' })],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(
        'The imported scene contains an image without its image data.',
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('routes a dropped scene through replacement semantics so old elements stay retired', async () => {
    const old = sceneElement({ id: 'old-shape', version: 3 });
    const imported = sceneElement({ id: 'imported-shape', type: 'ellipse' });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [imported],
      appState: appState(),
      files: {},
    });
    const published: (readonly CanvasElement[])[] = [];
    const onChange = vi.fn((next: readonly CanvasElement[]) => {
      published.push(next);
    });
    await renderCanvas({ elements: [old], onChange });
    excalidrawHarness.state.scene = [old];

    fireEvent.drop(screen.getByTestId('mock-excalidraw'), {
      clientX: 140,
      clientY: 180,
      dataTransfer: {
        files: [new File(['scene'], 'replacement.excalidraw', { type: 'application/json' })],
        types: ['Files'],
        dropEffect: 'none',
      },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledOnce();
    });
    expect(published[0]).toEqual([
      expect.objectContaining({ id: 'old-shape', isDeleted: true, version: 4 }),
      imported,
    ]);
  });

  it('ignores a second scene import while the first import is in flight', async () => {
    const imported = sceneElement({ id: 'imported-shape', type: 'ellipse' });
    excalidrawHarness.loadFromBlob.mockResolvedValue({
      elements: [imported],
      appState: appState(),
      files: {},
    });
    const onChange = vi.fn();
    const view = await renderCanvas({ onChange });
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('Expected the canvas scene file input.');

    fireEvent.change(input, {
      target: { files: [new File(['scene-a'], 'first.excalidraw', { type: 'application/json' })] },
    });
    fireEvent.change(input, {
      target: { files: [new File(['scene-b'], 'second.excalidraw', { type: 'application/json' })] },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledOnce();
    });
    expect(excalidrawHarness.loadFromBlob).toHaveBeenCalledOnce();
    expect(fileHarness.uploadAndCompleteFile).not.toHaveBeenCalled();
  });

  it('uploads and inserts an ordinary image dropped onto the canvas', async () => {
    const encodingError = new Error('This PNG has no embedded scene.');
    encodingError.name = 'EncodingError';
    excalidrawHarness.loadFromBlob.mockRejectedValue(encodingError);
    const onChange = vi.fn();
    await renderCanvas({ onChange });
    const file = new File(['image'], 'diagram.png', { type: 'image/png' });

    fireEvent.drop(screen.getByTestId('mock-excalidraw'), {
      clientX: 140,
      clientY: 180,
      dataTransfer: { files: [file], types: ['Files'], dropEffect: 'none' },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledOnce();
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'image',
        fileId: '30000000-0000-4000-8000-000000000003',
        status: 'saved',
        customData: {
          nix: { kind: 'file', itemId: '30000000-0000-4000-8000-000000000003' },
        },
      }),
    ]);
    expect(fileHarness.uploadAndCompleteFile).toHaveBeenCalledWith(
      fileHarness.client,
      { id: 'upload-1' },
      file,
      expect.any(AbortSignal),
    );
  });

  it('restores accepted image bytes when a dropped scene replaces Excalidraw files', async () => {
    const fileId = '30000000-0000-4000-8000-000000000003' as FileId;
    const safeImage = sceneElement({
      id: 'safe-image',
      type: 'image',
      fileId,
      status: 'saved',
      customData: { nix: { kind: 'file', itemId: fileId } },
    });
    const onChange = vi.fn();
    await renderCanvas({ elements: [safeImage], onChange });
    await waitFor(() => {
      expect(excalidrawHarness.addFiles).toHaveBeenCalled();
    });
    excalidrawHarness.addFiles.mockClear();
    const replacedImage = sceneElement({
      ...safeImage,
      version: 2,
      versionNonce: 5,
    });
    const foreignBytes: BinaryFiles = {
      [fileId]: {
        id: fileId,
        dataURL: 'data:image/png;base64,Zm9yZWlnbg==' as DataURL,
        mimeType: 'image/png',
        created: 2,
      },
    };
    excalidrawHarness.state.files = foreignBytes;

    act(() => {
      currentExcalidrawProps().onChange?.([replacedImage], appState(), foreignBytes);
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(excalidrawHarness.addFiles).toHaveBeenCalledWith([
      expect.objectContaining({
        id: fileId,
        dataURL: 'data:image/png;base64,bml4',
      }),
    ]);
    expect(excalidrawHarness.state.files[fileId]?.dataURL).toBe('data:image/png;base64,bml4');
  });
});
