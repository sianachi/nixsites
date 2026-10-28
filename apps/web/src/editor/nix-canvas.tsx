import {
  files as fileResources,
  items as coreItems,
  search,
  type NixClient,
  type SearchResults,
} from '@nix/api-client';
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  getDataURL,
  loadFromBlob,
  newElementWith,
  reconcileElements,
  restoreElements,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { FileId, OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
  LibraryItems,
  SocketId,
} from '@excalidraw/excalidraw/types';
import { Button, Dialog, Field, Icon, Input, Menu, Select, Text } from '@nix/ui';
import { MoreHorizontal, Plus, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { useApiClient } from '../api/api-client-provider';
import { isImageFile, mediaTypeForFile } from '@nix/web-foundation/lib/file-kind';
import type { Ground } from '@nix/web-foundation/theme/theme-store';
import { supersedes, type CanvasElement } from './canvas-binding';
import {
  canvasFileItemIds,
  externalCanvasFiles,
  itemIdFromNixLink,
  nixFileItemIdFromElement,
  nixItemIdFromElement,
  nixItemLink,
  prepareCanvasElements,
  sceneFingerprint,
  withNixFileMetadata,
} from './nix-canvas-model';
import { prepareCanvasLibraryItems } from './nix-canvas-library';
import { useCanvasLibrary } from './use-canvas-library';

// The editor owns the drawing chrome and its stylesheet. CanvasEditor is lazy at both page seams,
// so none of this enters the note-only route.
import '@excalidraw/excalidraw/index.css';

export interface NixCanvasProps {
  readonly elements: readonly CanvasElement[];
  readonly onChange: (elements: readonly CanvasElement[]) => void;
  readonly workspaceId?: string | undefined;
  readonly parentItemId?: string | undefined;
  readonly onOpenItem?: ((itemId: string) => void) | undefined;
  readonly awareness?: Awareness | undefined;
  readonly readOnly?: boolean | undefined;
  /** Template drafts do not yet have a durable parent to own uploaded file items. */
  readonly allowFileUploads?: boolean | undefined;
}

interface ItemOption {
  readonly id: string;
  readonly title: string;
}

const EMPTY_LIBRARY: LibraryItems = [];
const COLLABORATOR_COLOR_TOKENS = [
  { background: '--color-accent-100', stroke: '--color-accent-700' },
  { background: '--color-accent-2-100', stroke: '--color-accent-2-700' },
  { background: '--color-neutral-100', stroke: '--color-neutral-800' },
  { background: '--color-accent-200', stroke: '--color-accent-800' },
  { background: '--color-accent-2-200', stroke: '--color-accent-2-800' },
] as const;
const CANVAS_IMAGE_LOAD_NOTICE = 'One or more canvas images could not be loaded.';
const CANVAS_IMAGE_INGRESS_NOTICE =
  'Use Import for image-bearing Excalidraw scenes so Nix can store their images.';
type CanvasClipboardData = Parameters<NonNullable<ExcalidrawProps['onPaste']>>[0];
type ImportedCanvasScene = Awaited<ReturnType<typeof loadFromBlob>>;

/**
 * Excalidraw is the complete interaction engine. Nix supplies only durable scene transport,
 * capability-backed files, personal library persistence, item navigation and collaborator state.
 */
export function NixCanvas({
  elements,
  onChange,
  workspaceId,
  parentItemId,
  onOpenItem,
  awareness,
  readOnly = false,
  allowFileUploads = true,
}: NixCanvasProps): ReactNode {
  const client = useApiClient();
  const library = useCanvasLibrary();
  const ground = useCanvasGround();
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [itemOptions, setItemOptions] = useState<readonly ItemOption[]>([]);
  const [itemOptionsStatus, setItemOptionsStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  // What is typed into the picker's filter field, and the last search that came back for it.
  // The result carries its own query (`SearchResults.query`), the same idiom `ReferenceMenu`
  // uses, so a result that no longer matches what is typed - the field changed while the
  // request was in flight - reads as stale and is ignored, rather than kept in a second piece
  // of state that has to be reset in step with the first.
  const [itemFilter, setItemFilter] = useState('');
  const [filteredItems, setFilteredItems] = useState<SearchResults | null>(null);
  const [filterStatus, setFilterStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const canvasRootRef = useRef<HTMLDivElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  const lastPublishedFingerprintRef = useRef('');
  const suppressFingerprintRef = useRef<string | null>(null);
  const pendingRemoteElementsRef = useRef<readonly OrderedExcalidrawElement[] | null>(null);
  const savedFileIdsRef = useRef(new Set<FileId>());
  const pendingUploadedFileIdsRef = useRef(new Set<FileId>());
  const retiringFileIdsRef = useRef(new Set<FileId>());
  const sceneImportInFlightRef = useRef(false);
  const librarySeededRef = useRef(false);
  const mountedRef = useRef(true);
  const activeOperationsRef = useRef(new Set<AbortController>());

  useEffect(() => {
    const root = canvasRootRef.current;
    if (api === null || root === null) return;
    // shortcut: Excalidraw 0.18 needs DOM labels, remove when its controls expose these semantics.
    const labelCanvasControls = (): void => {
      root.querySelector('.main-menu-trigger')?.setAttribute('aria-label', 'Canvas menu');
      for (const footer of root.querySelectorAll('.excalidraw footer')) {
        footer.setAttribute('role', 'group');
        footer.setAttribute('aria-label', 'Canvas view controls');
      }
    };
    labelCanvasControls();
    const observer = new MutationObserver(labelCanvasControls);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [api]);

  const retirePendingUploads = useCallback(
    async (fileIds: readonly FileId[]): Promise<void> => {
      if (workspaceId === undefined) return;
      const claimed = fileIds.filter((fileId) => {
        if (
          !pendingUploadedFileIdsRef.current.has(fileId) ||
          retiringFileIdsRef.current.has(fileId)
        ) {
          return false;
        }
        pendingUploadedFileIdsRef.current.delete(fileId);
        savedFileIdsRef.current.delete(fileId);
        retiringFileIdsRef.current.add(fileId);
        return true;
      });
      if (claimed.length === 0) return;
      try {
        const failed = await retireUploadedFileItems(client, workspaceId, claimed);
        for (const fileId of failed) pendingUploadedFileIdsRef.current.add(fileId as FileId);
      } finally {
        for (const fileId of claimed) retiringFileIdsRef.current.delete(fileId);
      }
    },
    [client, workspaceId],
  );

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const preparedElements = useMemo(
    () => restoreElements(prepareCanvasElements(elements), null, { repairBindings: true }),
    [elements],
  );
  const lastSafeElementsRef = useRef<readonly OrderedExcalidrawElement[]>(preparedElements);
  const durableFileIds = useMemo(() => canvasFileItemIds(preparedElements), [preparedElements]);
  const durableFileKey = durableFileIds.join('|');
  const externalFiles = useMemo(() => externalCanvasFiles(preparedElements), [preparedElements]);
  const externalFileKey = externalFiles.map((file) => `${file.id}:${file.dataURL}`).join('|');
  const initialFiles = useMemo(() => filesById(externalFiles), [externalFiles]);
  const lastSafeFilesRef = useRef<BinaryFiles>(initialFiles);
  const [initialData] = useState<{
    readonly elements: readonly OrderedExcalidrawElement[];
    readonly files: BinaryFiles;
    readonly libraryItems: LibraryItems;
    readonly scrollToContent: boolean;
  }>(() => ({
    elements: preparedElements,
    files: initialFiles,
    libraryItems: EMPTY_LIBRARY,
    scrollToContent: preparedElements.length > 0,
  }));

  useEffect(() => {
    mountedRef.current = true;
    const activeOperations = activeOperationsRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of activeOperations) controller.abort();
      activeOperations.clear();
    };
  }, []);

  useEffect(
    () => () => {
      void retirePendingUploads([...pendingUploadedFileIdsRef.current]);
    },
    [retirePendingUploads],
  );

  useEffect(() => {
    if (!readOnly) return;
    for (const controller of activeOperationsRef.current) controller.abort();
    void retirePendingUploads([...pendingUploadedFileIdsRef.current]);
  }, [readOnly, retirePendingUploads]);

  // initialData is mount-only. Every later Yjs snapshot is reconciled imperatively, preserving
  // an element currently being manipulated locally and excluding remote work from local undo.
  useEffect(() => {
    if (api === null) return;
    const current = api.getSceneElementsIncludingDeleted();
    const incomingFingerprint = sceneFingerprint(preparedElements);
    if (sceneFingerprint(current) === incomingFingerprint) {
      pendingRemoteElementsRef.current = null;
      lastSafeElementsRef.current = preparedElements;
      return;
    }

    const reconciled = reconcileElements(
      current,
      preparedElements as unknown as Parameters<typeof reconcileElements>[1],
      api.getAppState(),
    );
    const reconciledFingerprint = sceneFingerprint(reconciled);
    const durableWinners = durableSceneWinners(reconciled, preparedElements);
    const durableFingerprint = sceneFingerprint(durableWinners);
    pendingRemoteElementsRef.current =
      reconciledFingerprint === durableFingerprint ? null : durableWinners;
    lastSafeElementsRef.current = durableWinners;
    suppressFingerprintRef.current = reconciledFingerprint;
    api.updateScene({
      elements: reconciled,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    // Excalidraw also retains an older local element while it is actively manipulated. Only
    // publish actual version/nonce winners; otherwise the Yjs map would correctly reject the
    // stale value while the editor remained stuck displaying it.
    if (durableFingerprint !== incomingFingerprint) {
      lastPublishedFingerprintRef.current = durableFingerprint;
      onChangeRef.current(durableWinners);
    }
  }, [api, preparedElements]);

  // Old URL-backed images are supported only as a recovery path. Their address lives in legacy
  // customData; it is never copied into a newly authored scene record.
  useEffect(() => {
    if (api === null || externalFiles.length === 0) return;
    api.addFiles(externalFiles);
    lastSafeFilesRef.current = mergeCanvasFiles(lastSafeFilesRef.current, externalFiles);
  }, [api, externalFileKey, externalFiles]);

  // A personal library arrives independently of the scene. Seed once: updateLibrary announces
  // its result through onLibraryChange, and repeatedly seeding that echo creates a PUT loop.
  useEffect(() => {
    if (api === null || library.status !== 'ready' || librarySeededRef.current) return;
    librarySeededRef.current = true;
    void api.updateLibrary({
      libraryItems: prepareCanvasLibraryItems(library.items),
      merge: false,
    });
  }, [api, library.items, library.status]);

  // Rehydrate every durable image ID through a fresh preview capability. Only the resulting
  // in-memory data URL reaches Excalidraw; the shared element continues to contain the file item ID.
  useEffect(() => {
    if (api === null || durableFileKey === '') return;
    const currentFileIds = durableFileKey.split('|') as FileId[];
    const controller = new AbortController();
    const present = api.getFiles();
    const missing = currentFileIds.filter((fileId) => present[fileId] === undefined);

    for (const fileId of currentFileIds) {
      if (present[fileId] !== undefined) savedFileIdsRef.current.add(fileId);
    }
    if (missing.length === 0) {
      publishSavedImageStatuses(
        api,
        savedFileIdsRef.current,
        onChangeRef,
        lastPublishedFingerprintRef,
        suppressFingerprintRef,
      );
      return () => {
        controller.abort();
      };
    }

    void Promise.allSettled(
      missing.map(async (fileId): Promise<BinaryFileData> => {
        const { blob, capability } = await fileResources.fetchFileContent(
          client,
          fileId,
          undefined,
          true,
          controller.signal,
        );
        const mimeType = canvasImageMimeType(capability.mediaType);
        if (mimeType === null) {
          throw new Error('The referenced file is not a supported canvas image.');
        }
        return {
          id: fileId,
          dataURL: await getDataURL(blob),
          mimeType,
          created: Date.now(),
          lastRetrieved: Date.now(),
        };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const loaded = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      const failures = results.filter((result) => result.status === 'rejected');
      if (loaded.length > 0) {
        api.addFiles(loaded);
        lastSafeFilesRef.current = mergeCanvasFiles(lastSafeFilesRef.current, loaded);
      }
      for (const file of loaded) savedFileIdsRef.current.add(file.id);
      publishSavedImageStatuses(
        api,
        savedFileIdsRef.current,
        onChangeRef,
        lastPublishedFingerprintRef,
        suppressFingerprintRef,
      );
      if (failures.length === 0) {
        setFileNotice((current) => (current === CANVAS_IMAGE_LOAD_NOTICE ? null : current));
        return;
      }
      for (const failure of failures) {
        console.warn('A canvas image could not be loaded.', failure.reason);
      }
      setFileNotice(CANVAS_IMAGE_LOAD_NOTICE);
    });

    return () => {
      controller.abort();
    };
  }, [api, client, durableFileKey]);

  useEffect(() => {
    if (!itemDialogOpen || workspaceId === undefined) return;
    const controller = new AbortController();
    void (async () => {
      const options: ItemOption[] = [];
      try {
        for await (const item of client.paginate(
          coreItems.listItems(workspaceId, { pageSize: 100 }),
          { signal: controller.signal },
        )) {
          options.push({ id: item.id, title: item.title });
          if (options.length >= 100) break;
        }
        if (controller.signal.aborted) return;
        setItemOptions(options);
        setSelectedItemId((current) => (current !== '' ? current : (options[0]?.id ?? '')));
        setItemOptionsStatus('ready');
      } catch (cause) {
        if (controller.signal.aborted) return;
        console.warn('Canvas item choices could not be loaded.', cause);
        setItemOptions([]);
        setItemOptionsStatus('error');
      }
    })();
    return () => {
      controller.abort();
    };
  }, [client, itemDialogOpen, workspaceId]);

  useEffect(() => {
    if (!itemDialogOpen || workspaceId === undefined) return;
    const trimmed = itemFilter.trim();
    // Fewer than three letters is too little for the server's full-text search to narrow
    // usefully - `ReferenceMenu` draws the same line - so a short filter asks nothing, and the
    // picker falls back to the unfiltered first page below.
    if (trimmed.length < 3) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFilterStatus('loading');
      void client
        .query(search.searchItems(trimmed, 100), { signal: controller.signal })
        .then((results) => {
          if (controller.signal.aborted) return;
          setFilteredItems(results);
          setFilterStatus('ready');
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          console.warn('The canvas item search could not run.', cause);
          setFilterStatus('error');
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, itemDialogOpen, itemFilter, workspaceId]);

  const uploadCanvasFile = useCallback(
    async (file: File, operationSignal?: AbortSignal): Promise<FileId> => {
      if (!isImageFile(file)) {
        const message = 'Canvas images must be PNG, JPEG, WebP, or AVIF files.';
        if (mountedRef.current) setFileNotice(message);
        throw new Error(message);
      }
      if (
        readOnly ||
        !allowFileUploads ||
        workspaceId === undefined ||
        parentItemId === undefined
      ) {
        const message = 'Images cannot be uploaded in this canvas.';
        if (mountedRef.current) setFileNotice(message);
        throw new Error(message);
      }
      const ownedController = operationSignal === undefined ? new AbortController() : null;
      const signal = operationSignal ?? ownedController?.signal;
      if (ownedController !== null) activeOperationsRef.current.add(ownedController);
      throwIfAborted(signal);
      if (mountedRef.current) {
        setUploading(true);
        setFileNotice(null);
      }
      try {
        const uploaded = await uploadFileItem(client, workspaceId, parentItemId, file, signal);
        const fileId = uploaded as FileId;
        savedFileIdsRef.current.add(fileId);
        pendingUploadedFileIdsRef.current.add(fileId);
        return fileId;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'The canvas image upload failed.';
        if (mountedRef.current && !isAbortError(cause)) setFileNotice(message);
        throw cause;
      } finally {
        if (ownedController !== null) activeOperationsRef.current.delete(ownedController);
        if (mountedRef.current) setUploading(false);
      }
    },
    [allowFileUploads, client, parentItemId, readOnly, workspaceId],
  );

  const handlePaste = useCallback(
    async (data: CanvasClipboardData): Promise<boolean> => {
      if (api === null || data.elements === undefined) return true;
      const referenced = new Set(
        data.elements.flatMap((element) =>
          !element.isDeleted && element.type === 'image' && element.fileId !== null
            ? [element.fileId]
            : [],
        ),
      );
      if (referenced.size === 0) return true;
      if (
        readOnly ||
        !allowFileUploads ||
        workspaceId === undefined ||
        parentItemId === undefined
      ) {
        if (mountedRef.current) {
          setFileNotice('This canvas can paste shapes and text, but not images.');
        }
        return false;
      }

      const controller = new AbortController();
      activeOperationsRef.current.add(controller);
      const replacements = new Map<FileId, FileId>();
      const remappedFiles: BinaryFileData[] = [];
      const uploadedFileIds: FileId[] = [];
      const currentDurableFileIds = new Set(
        canvasFileItemIds(api.getSceneElementsIncludingDeleted()),
      );
      try {
        for (const sourceId of referenced) {
          throwIfAborted(controller.signal);
          const sourceFile = data.files?.[sourceId];
          if (sourceFile === undefined) {
            const canReuseCurrentFile =
              currentDurableFileIds.has(sourceId) &&
              data.elements.some(
                (element) =>
                  element.type === 'image' &&
                  element.fileId === sourceId &&
                  nixFileItemIdFromElement(element) === sourceId,
              );
            if (canReuseCurrentFile) continue;
            throw new Error('The pasted canvas image does not include reloadable image data.');
          }
          if (canvasImageMimeType(sourceFile.mimeType) === null) {
            throw new Error('The pasted canvas contains an image format Nix cannot reload.');
          }
          const blob = canvasDataUrlToBlob(sourceFile.dataURL, sourceFile.mimeType);
          const localFile = new File(
            [blob],
            `pasted-canvas-image-${sourceId}.${fileExtension(sourceFile.mimeType)}`,
            { type: sourceFile.mimeType },
          );
          const nextId = await uploadCanvasFile(localFile, controller.signal);
          uploadedFileIds.push(nextId);
          replacements.set(sourceId, nextId);
          remappedFiles.push({ ...sourceFile, id: nextId, lastRetrieved: Date.now() });
        }

        throwIfAborted(controller.signal);
        data.elements = data.elements.map((element) => {
          if (element.type !== 'image' || element.fileId === null) return element;
          const replacement = replacements.get(element.fileId);
          return replacement === undefined
            ? element
            : newElementWith(element, {
                fileId: replacement,
                status: 'saved',
                customData: withNixFileMetadata(element, replacement),
              });
        });
        data.files = filesById(remappedFiles);
        return true;
      } catch (cause) {
        await retirePendingUploads(uploadedFileIds);
        if (mountedRef.current && !isAbortError(cause)) {
          const message =
            cause instanceof Error ? cause.message : 'The canvas image could not be pasted.';
          console.warn('A canvas image could not be pasted.', cause);
          setFileNotice(message);
        }
        return false;
      } finally {
        activeOperationsRef.current.delete(controller);
      }
    },
    [
      allowFileUploads,
      api,
      parentItemId,
      readOnly,
      retirePendingUploads,
      uploadCanvasFile,
      workspaceId,
    ],
  );

  const publish = useCallback(
    (nextElements: readonly OrderedExcalidrawElement[]): void => {
      if (api === null) return;
      onChangeRef.current(nextElements);
      const fingerprint = sceneFingerprint(nextElements);
      suppressFingerprintRef.current = fingerprint;
      lastPublishedFingerprintRef.current = fingerprint;
      lastSafeElementsRef.current = nextElements;
      api.updateScene({ elements: nextElements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
    [api],
  );

  // What the "Add a Nix item" picker actually shows: a search's own matches once three letters
  // are typed - the same floor `ReferenceMenu` uses - the unfiltered first page otherwise. Both
  // are capped at 100 by the request that fetched them, so both can be a cut, not a complete,
  // list - the notice in the dialog below says so rather than presenting either as everything
  // the workspace holds. `currentSearch` drops a result that no longer matches what is typed,
  // the way `ReferenceMenu` does, so a stale response arriving after the field changed is never
  // shown as if it answered the query on screen now.
  const searching = itemFilter.trim().length >= 3;
  const currentSearch =
    filteredItems !== null && filteredItems.query === itemFilter.trim() ? filteredItems : null;
  // Memoised so `insertNixItem` below - and its own memoisation - sees a stable list rather than
  // a fresh array on every render this component makes for reasons that have nothing to do with
  // the picker, such as a collaborator's cursor moving.
  const shownItemOptions: readonly ItemOption[] = useMemo(
    () =>
      searching
        ? (currentSearch?.results
            .filter((hit) => hit.workspaceId === workspaceId)
            .map((hit) => ({ id: hit.id, title: hit.title ?? '' })) ?? [])
        : itemOptions,
    [currentSearch, itemOptions, searching, workspaceId],
  );
  const shownItemStatus = searching ? filterStatus : itemOptionsStatus;
  const itemsTruncated = searching
    ? (currentSearch?.truncated ?? false)
    : itemOptions.length >= 100;
  // Corrected here rather than written back into `selectedItemId` by an effect: the raw state
  // stays exactly what the person last chose, and this is only what the dialog acts on when
  // that choice has since scrolled out of the shown list - a narrower search, most often.
  const effectiveSelectedItemId =
    shownItemOptions.length === 0
      ? ''
      : shownItemOptions.some((option) => option.id === selectedItemId)
        ? selectedItemId
        : (shownItemOptions[0]?.id ?? '');

  const insertNixItem = useCallback((): void => {
    if (api === null || effectiveSelectedItemId === '' || readOnly) return;
    const option = shownItemOptions.find((candidate) => candidate.id === effectiveSelectedItemId);
    if (option === undefined) return;
    const appState = api.getAppState();
    const zoom = appState.zoom.value;
    const width = 260;
    const height = 120;
    const x = appState.width / (2 * zoom) - appState.scrollX - width / 2;
    const y = appState.height / (2 * zoom) - appState.scrollY - height / 2;
    const inserted = convertToExcalidrawElements(
      [
        {
          type: 'rectangle',
          x,
          y,
          width,
          height,
          strokeColor: appState.currentItemStrokeColor,
          backgroundColor: appState.currentItemBackgroundColor,
          fillStyle: appState.currentItemFillStyle,
          strokeWidth: appState.currentItemStrokeWidth,
          strokeStyle: appState.currentItemStrokeStyle,
          roughness: appState.currentItemRoughness,
          opacity: appState.currentItemOpacity,
          roundness: { type: 3 },
          link: nixItemLink(option.id),
          customData: { nix: { kind: 'item', itemId: option.id } },
          label: { text: option.title || 'Untitled item' },
        },
      ],
      { regenerateIds: true },
    );
    const next = [...api.getSceneElementsIncludingDeleted(), ...inserted];
    publish(next);
    api.scrollToContent(inserted, { fitToContent: true, animate: true });
    setItemDialogOpen(false);
  }, [api, effectiveSelectedItemId, publish, readOnly, shownItemOptions]);

  const insertDroppedImage = useCallback(
    async (file: File, clientPoint: { readonly clientX: number; readonly clientY: number }) => {
      if (api === null || readOnly) return;
      const controller = new AbortController();
      activeOperationsRef.current.add(controller);
      let uploadedFileId: FileId | null = null;
      let sceneOwnsUploadedFile = false;
      try {
        const mimeType = canvasImageMimeType(mediaTypeForFile(file));
        if (mimeType === null || !isImageFile(file)) {
          throw new Error('Canvas images must be PNG, JPEG, WebP, or AVIF files.');
        }
        const [dataURL, dimensions] = await Promise.all([
          getDataURL(file),
          canvasImageDimensions(file),
        ]);
        throwIfAborted(controller.signal);
        uploadedFileId = await uploadCanvasFile(file, controller.signal);
        const binaryFile: BinaryFileData = {
          id: uploadedFileId,
          dataURL,
          mimeType,
          created: Date.now(),
          lastRetrieved: Date.now(),
        };
        const appState = api.getAppState();
        const point = viewportCoordsToSceneCoords(clientPoint, appState);
        const [imageElement] = convertToExcalidrawElements(
          [
            {
              type: 'image',
              x: point.x - dimensions.width / 2,
              y: point.y - dimensions.height / 2,
              width: dimensions.width,
              height: dimensions.height,
              fileId: uploadedFileId,
              status: 'saved',
              scale: [1, 1],
              crop: null,
              customData: { nix: { kind: 'file', itemId: uploadedFileId } },
            },
          ],
          { regenerateIds: true },
        );
        if (imageElement === undefined) {
          throw new Error('The dropped image could not be placed on the canvas.');
        }
        throwIfAborted(controller.signal);
        const nextElements = [...api.getSceneElementsIncludingDeleted(), imageElement];
        api.addFiles([binaryFile]);
        lastSafeFilesRef.current = mergeCanvasFiles(lastSafeFilesRef.current, [binaryFile]);
        onChangeRef.current(nextElements);
        sceneOwnsUploadedFile = true;
        pendingUploadedFileIdsRef.current.delete(uploadedFileId);
        const fingerprint = sceneFingerprint(nextElements);
        suppressFingerprintRef.current = fingerprint;
        lastPublishedFingerprintRef.current = fingerprint;
        lastSafeElementsRef.current = nextElements;
        api.updateScene({
          elements: nextElements,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.scrollToContent([imageElement], { fitToContent: true, animate: true });
      } catch (cause) {
        if (!sceneOwnsUploadedFile && uploadedFileId !== null) {
          await retirePendingUploads([uploadedFileId]);
        }
        if (mountedRef.current && !isAbortError(cause)) {
          const message =
            cause instanceof Error ? cause.message : 'The canvas image could not be inserted.';
          console.warn('A dropped canvas image could not be inserted.', cause);
          setFileNotice(message);
        }
      } finally {
        activeOperationsRef.current.delete(controller);
      }
    },
    [api, readOnly, retirePendingUploads, uploadCanvasFile],
  );

  const importScene = useCallback(
    async (file: File, loadedScene?: ImportedCanvasScene): Promise<void> => {
      if (api === null || readOnly || sceneImportInFlightRef.current) return;
      sceneImportInFlightRef.current = true;
      const controller = new AbortController();
      activeOperationsRef.current.add(controller);
      const uploadedFileIds: FileId[] = [];
      let sceneOwnsUploadedFiles = false;
      if (mountedRef.current) {
        setImporting(true);
        setFileNotice(null);
      }
      try {
        const imported = loadedScene ?? (await loadFromBlob(file, api.getAppState(), null));
        throwIfAborted(controller.signal);
        const referenced = new Set(
          imported.elements.flatMap((element) =>
            !element.isDeleted && element.type === 'image' && element.fileId !== null
              ? [element.fileId]
              : [],
          ),
        );
        if (
          referenced.size > 0 &&
          (!allowFileUploads || workspaceId === undefined || parentItemId === undefined)
        ) {
          throw new Error('This scene contains images, but this canvas cannot own uploaded files.');
        }
        const replacements = new Map<FileId, FileId>();
        const remappedFiles: BinaryFileData[] = [];
        const currentDurableFileIds = new Set(
          canvasFileItemIds(api.getSceneElementsIncludingDeleted()),
        );

        for (const importedFile of Object.values(imported.files)) {
          if (!referenced.has(importedFile.id)) continue;
          throwIfAborted(controller.signal);
          if (canvasImageMimeType(importedFile.mimeType) === null) {
            throw new Error('The imported scene contains an image format Nix cannot reload.');
          }
          const blob = canvasDataUrlToBlob(importedFile.dataURL, importedFile.mimeType);
          const localFile = new File(
            [blob],
            `imported-canvas-image-${importedFile.id}.${fileExtension(importedFile.mimeType)}`,
            { type: importedFile.mimeType },
          );
          const nextId = await uploadCanvasFile(localFile, controller.signal);
          uploadedFileIds.push(nextId);
          replacements.set(importedFile.id, nextId);
          remappedFiles.push({ ...importedFile, id: nextId, lastRetrieved: Date.now() });
        }

        const unresolvedImage = imported.elements.find(
          (element) =>
            !element.isDeleted &&
            element.type === 'image' &&
            element.fileId !== null &&
            !replacements.has(element.fileId) &&
            !(
              currentDurableFileIds.has(element.fileId) &&
              nixFileItemIdFromElement(element) === element.fileId
            ),
        );
        if (unresolvedImage !== undefined) {
          throw new Error('The imported scene contains an image without its image data.');
        }

        const importedElements = imported.elements.map((element) => {
          if (element.type !== 'image' || element.fileId === null) return element;
          const replacement = replacements.get(element.fileId);
          return replacement === undefined
            ? element
            : newElementWith(element, {
                fileId: replacement,
                status: 'saved',
                customData: withNixFileMetadata(element, replacement),
              });
        });
        const nextElements = replaceImportedScene(
          api.getSceneElementsIncludingDeleted(),
          importedElements,
        );
        throwIfAborted(controller.signal);
        if (remappedFiles.length > 0) {
          api.addFiles(remappedFiles);
          lastSafeFilesRef.current = mergeCanvasFiles(lastSafeFilesRef.current, remappedFiles);
        }
        const fingerprint = sceneFingerprint(nextElements);
        suppressFingerprintRef.current = fingerprint;
        lastPublishedFingerprintRef.current = fingerprint;
        onChangeRef.current(nextElements);
        // The synchronous document callback now owns these files. A later imperative rendering
        // failure must not delete children already referenced by the shared scene.
        sceneOwnsUploadedFiles = true;
        lastSafeElementsRef.current = nextElements;
        for (const fileId of uploadedFileIds) pendingUploadedFileIdsRef.current.delete(fileId);
        api.updateScene({
          elements: nextElements,
          appState: { ...imported.appState, theme: ground },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.scrollToContent(
          importedElements.filter((element) => !element.isDeleted),
          { fitToContent: true, animate: true },
        );
      } catch (cause) {
        if (!sceneOwnsUploadedFiles) await retirePendingUploads(uploadedFileIds);
        if (mountedRef.current && !isAbortError(cause)) {
          const message =
            cause instanceof Error ? cause.message : 'The canvas file could not be imported.';
          console.warn('A canvas scene could not be imported.', cause);
          setFileNotice(message);
        }
      } finally {
        sceneImportInFlightRef.current = false;
        activeOperationsRef.current.delete(controller);
        if (mountedRef.current) setImporting(false);
      }
    },
    [
      allowFileUploads,
      api,
      ground,
      parentItemId,
      readOnly,
      retirePendingUploads,
      uploadCanvasFile,
      workspaceId,
    ],
  );

  const handleFileDrop = useCallback(
    async (
      file: File,
      clientPoint: { readonly clientX: number; readonly clientY: number },
    ): Promise<void> => {
      if (api === null || readOnly || sceneImportInFlightRef.current) return;
      const name = file.name.toLowerCase();
      const sceneFile =
        name.endsWith('.excalidraw') ||
        name.endsWith('.json') ||
        name.endsWith('.svg') ||
        file.type === 'application/json' ||
        file.type === 'image/svg+xml';
      if (sceneFile) {
        await importScene(file);
        return;
      }
      if (isImageFile(file) && (file.type === 'image/png' || name.endsWith('.png'))) {
        try {
          const loaded = await loadFromBlob(file, api.getAppState(), null);
          await importScene(file, loaded);
          return;
        } catch (cause) {
          if (!isEncodingError(cause)) {
            const message =
              cause instanceof Error ? cause.message : 'The dropped canvas file could not be read.';
            console.warn('A dropped canvas file could not be read.', cause);
            if (mountedRef.current) setFileNotice(message);
            return;
          }
        }
      }
      await insertDroppedImage(file, clientPoint);
    },
    [api, importScene, insertDroppedImage, readOnly],
  );

  const collaboratorSnapshot = useAwarenessSnapshot(awareness);
  const collaborators = useMemo(
    () => collaboratorsFromSnapshot(collaboratorSnapshot),
    [collaboratorSnapshot],
  );
  useEffect(() => {
    if (api === null) return;
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, collaborators]);

  const imageToolsEnabled =
    !readOnly &&
    !importing &&
    allowFileUploads &&
    workspaceId !== undefined &&
    parentItemId !== undefined;
  const importLabel = allowFileUploads
    ? 'Import an Excalidraw scene'
    : 'Import an Excalidraw scene without images';

  function openItemPicker(): void {
    setItemOptionsStatus('loading');
    // A fresh open starts from the unfiltered first page.
    setItemFilter('');
    setItemDialogOpen(true);
  }

  return (
    <div
      ref={canvasRootRef}
      className="@container/canvas relative h-full min-h-0 min-w-0 w-full overflow-hidden bg-background @max-5xl/canvas:[&_.App-menu\_top]:grid-cols-[auto_minmax(0,1fr)]! @max-5xl/canvas:[&_.App-menu\_top]:gap-x-4! @max-5xl/canvas:[&_.App-menu\_top]:gap-y-8! @max-5xl/canvas:[&_.App-menu\_top>.layer-ui\_\_wrapper\_\_top-right]:col-span-2! [&_.App-top-bar>section]:w-full! [&_.App-top-bar>section>.Stack]:w-full! [&_.App-top-bar_.App-toolbar-container]:relative! [&_.App-top-bar_.App-toolbar-container]:w-full! [&_.App-top-bar_.App-toolbar-container]:grid-cols-1! [&_.App-top-bar_.App-toolbar-container]:grid-flow-row! [&_.App-toolbar--mobile]:w-full! [&_.App-toolbar--mobile]:max-w-full! [&_.App-toolbar--mobile>.Stack]:grid-flow-row! [&_.App-toolbar--mobile>.Stack]:grid-cols-[repeat(auto-fit,minmax(var(--control-lg),1fr))]! [&_.App-toolbar--mobile_.ToolIcon]:min-h-(--control-lg)! [&_.App-toolbar--mobile_.ToolIcon]:min-w-(--control-lg)! [&_.mobile-misc-tools-container]:top-full! [&_.mobile-misc-tools-container]:mt-2!"
      role="region"
      aria-label="Canvas workspace"
      onDragOverCapture={(event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDropCapture={(event: ReactDragEvent<HTMLDivElement>) => {
        const file = event.dataTransfer.files[0];
        if (file === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        void handleFileDrop(file, { clientX: event.clientX, clientY: event.clientY });
      }}
    >
      <input
        ref={importInputRef}
        className="sr-only"
        type="file"
        aria-label={importLabel}
        tabIndex={-1}
        accept=".excalidraw,.json,.png,.svg,application/json,image/png,image/svg+xml"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) void importScene(file);
        }}
      />
      <div className="absolute inset-0">
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={setApi}
          theme={ground}
          viewModeEnabled={readOnly || importing}
          isCollaborating={awareness !== undefined}
          handleKeyboardGlobally={false}
          aiEnabled={false}
          validateEmbeddable={false}
          onPaste={handlePaste}
          {...(imageToolsEnabled ? { generateIdForFile: uploadCanvasFile } : {})}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              changeViewBackgroundColor: false,
              toggleTheme: false,
              clearCanvas: !readOnly && !importing,
              export: { saveFileToDisk: true },
              saveAsImage: true,
            },
            tools: { image: imageToolsEnabled },
          }}
          renderTopRightUI={(isMobile) =>
            readOnly ? null : isMobile ? (
              <div className="absolute top-full left-0 mt-2">
                <Menu
                  label="Canvas actions"
                  items={[
                    {
                      label: importLabel,
                      icon: Upload,
                      disabled: importing || uploading,
                      onSelect: () => importInputRef.current?.click(),
                    },
                    ...(workspaceId === undefined
                      ? []
                      : [
                          {
                            label: 'Add a Nix item to the canvas',
                            icon: Plus,
                            disabled: importing || uploading,
                            onSelect: openItemPicker,
                          },
                        ]),
                  ]}
                >
                  {(trigger) => (
                    <Button {...trigger} variant="icon" aria-label="Canvas actions">
                      <Icon icon={MoreHorizontal} size="sm" />
                    </Button>
                  )}
                </Menu>
              </div>
            ) : (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  className="shrink-0 whitespace-nowrap"
                  aria-label={importLabel}
                  title={
                    allowFileUploads
                      ? undefined
                      : 'This canvas can import shapes and text, but not images.'
                  }
                  disabled={importing || uploading}
                  onClick={() => importInputRef.current?.click()}
                >
                  <Icon icon={Upload} size="sm" />
                  {allowFileUploads ? 'Import' : 'Import shapes'}
                </Button>
                {workspaceId === undefined ? null : (
                  <Button
                    variant="secondary"
                    className="shrink-0 whitespace-nowrap"
                    aria-label="Add a Nix item to the canvas"
                    disabled={importing || uploading}
                    onClick={openItemPicker}
                  >
                    <Icon icon={Plus} size="sm" />
                    Nix item
                  </Button>
                )}
              </div>
            )
          }
          onChange={(nextElements, appState, files) => {
            awareness?.setLocalStateField('canvas', {
              ...localCanvasAwareness(awareness),
              selectedElementIds: appState.selectedElementIds,
            });

            let localElements = nextElements;
            const pendingRemote = pendingRemoteElementsRef.current;
            if (pendingRemote !== null && !isActivelyEditingCanvas(appState)) {
              const settled = reconcileElements(
                nextElements,
                pendingRemote as unknown as Parameters<typeof reconcileElements>[1],
                appState,
              );
              localElements = durableSceneWinners(settled, pendingRemote);
              pendingRemoteElementsRef.current = null;

              const pendingFingerprint = sceneFingerprint(pendingRemote);
              const settledFingerprint = sceneFingerprint(localElements);
              if (settledFingerprint === pendingFingerprint) {
                suppressFingerprintRef.current = settledFingerprint;
                lastPublishedFingerprintRef.current = settledFingerprint;
                lastSafeElementsRef.current = localElements;
                if (sceneFingerprint(nextElements) !== settledFingerprint && api !== null) {
                  api.updateScene({
                    elements: localElements,
                    captureUpdate: CaptureUpdateAction.NEVER,
                  });
                }
                return;
              }

              if (sceneFingerprint(nextElements) !== settledFingerprint && api !== null) {
                api.updateScene({
                  elements: localElements,
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
              }
            }

            if (
              hasUnownedCanvasImages(
                localElements,
                lastSafeElementsRef.current,
                pendingUploadedFileIdsRef.current,
                files,
                lastSafeFilesRef.current,
              )
            ) {
              const safeElements = lastSafeElementsRef.current;
              const safeFingerprint = sceneFingerprint(safeElements);
              suppressFingerprintRef.current = safeFingerprint;
              lastPublishedFingerprintRef.current = safeFingerprint;
              if (api !== null) {
                api.updateScene({
                  elements: safeElements,
                  captureUpdate: CaptureUpdateAction.NEVER,
                });
                api.addFiles(Object.values(lastSafeFilesRef.current));
              }
              setFileNotice(CANVAS_IMAGE_INGRESS_NOTICE);
              return;
            }

            const saved = markSavedImages(localElements, pendingUploadedFileIdsRef.current);
            const nextFingerprint = sceneFingerprint(saved.elements);
            if (saved.changed && api !== null) {
              suppressFingerprintRef.current = nextFingerprint;
              lastPublishedFingerprintRef.current = nextFingerprint;
              lastSafeElementsRef.current = saved.elements;
              lastSafeFilesRef.current = mergeCanvasFiles(
                lastSafeFilesRef.current,
                Object.values(files),
              );
              consumePendingImageIds(saved.elements, pendingUploadedFileIdsRef.current);
              api.updateScene({
                elements: saved.elements,
                captureUpdate: CaptureUpdateAction.NEVER,
              });
              setFileNotice((current) =>
                current === CANVAS_IMAGE_INGRESS_NOTICE ? null : current,
              );
              onChangeRef.current(saved.elements);
              return;
            }
            if (suppressFingerprintRef.current === nextFingerprint) {
              suppressFingerprintRef.current = null;
              return;
            }
            if (lastPublishedFingerprintRef.current === nextFingerprint) return;
            lastPublishedFingerprintRef.current = nextFingerprint;
            lastSafeElementsRef.current = saved.elements;
            lastSafeFilesRef.current = mergeCanvasFiles(
              lastSafeFilesRef.current,
              Object.values(files),
            );
            consumePendingImageIds(saved.elements, pendingUploadedFileIdsRef.current);
            setFileNotice((current) => (current === CANVAS_IMAGE_INGRESS_NOTICE ? null : current));
            onChangeRef.current(saved.elements);
          }}
          onPointerUpdate={({ pointer, button }) => {
            awareness?.setLocalStateField('canvas', {
              ...localCanvasAwareness(awareness),
              pointer,
              button,
            });
          }}
          onLibraryChange={(nextItems) => {
            library.save(nextItems);
          }}
          onLinkOpen={(element, event) => {
            const itemId = nixItemIdFromElement(element) ?? itemIdFromNixLink(element.link);
            if (itemId === null || onOpenItem === undefined) return;
            event.preventDefault();
            onOpenItem(itemId);
          }}
        />
      </div>

      {fileNotice === null && !uploading && !importing ? null : (
        <div
          className="pointer-events-none absolute right-3 bottom-12 left-3 z-20 rounded-md border border-divider bg-background px-3 py-2 shadow-sm sm:right-auto sm:left-1/2 sm:w-fit sm:max-w-full sm:-translate-x-1/2"
          role="status"
          aria-live="polite"
        >
          <Text variant="caption" className="[overflow-wrap:anywhere]">
            {fileNotice ?? (importing ? 'Importing canvas…' : 'Uploading image…')}
          </Text>
        </div>
      )}

      {readOnly ? <span className="sr-only">Canvas is read only.</span> : null}

      <Dialog
        open={itemDialogOpen}
        title="Add a Nix item"
        onClose={() => {
          setItemDialogOpen(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setItemDialogOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={effectiveSelectedItemId === '' || shownItemStatus !== 'ready'}
              onClick={insertNixItem}
            >
              Add item
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Filter items" hint="Type to search the workspace.">
            {(control) => (
              <Input
                {...control}
                value={itemFilter}
                disabled={itemOptionsStatus === 'error'}
                onChange={(event) => {
                  setItemFilter(event.target.value);
                }}
              />
            )}
          </Field>
          {itemOptionsStatus === 'error' && !searching ? (
            <Text role="alert">The workspace items could not be loaded.</Text>
          ) : shownItemStatus === 'error' ? (
            <Text role="alert">The search could not run. Check your connection and try again.</Text>
          ) : (
            <Field label="Item">
              {(control) => (
                <Select
                  {...control}
                  disabled={shownItemStatus !== 'ready' || shownItemOptions.length === 0}
                  value={effectiveSelectedItemId}
                  onChange={(event) => {
                    setSelectedItemId(event.target.value);
                  }}
                >
                  {shownItemOptions.length === 0 ? (
                    <option value="">
                      {shownItemStatus === 'loading'
                        ? 'Loading items…'
                        : searching
                          ? 'No items match your search'
                          : 'No items available'}
                    </option>
                  ) : (
                    shownItemOptions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.title || 'Untitled item'}
                      </option>
                    ))
                  )}
                </Select>
              )}
            </Field>
          )}
          {itemsTruncated && shownItemStatus === 'ready' ? (
            <Text variant="caption">
              {searching
                ? 'Showing the first 100 matches. Narrow your search to see more.'
                : 'Showing the first 100 items. Type to search the rest of the workspace.'}
            </Text>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

async function uploadFileItem(
  client: NixClient,
  workspaceId: string,
  parentItemId: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  const upload = await client.execute(
    fileResources.beginUpload({
      workspaceId,
      parentId: parentItemId,
      fileName: file.name || 'canvas-image',
      mediaType: mediaTypeForFile(file),
      byteLength: file.size,
      idempotencyKey: `web-canvas-image:${crypto.randomUUID()}`,
    }),
    signal === undefined ? undefined : { signal },
  );
  const record = await fileResources.uploadAndCompleteFile(client, upload, file, signal);
  if (signal?.aborted || !record.current.previewable) {
    await retireUploadedFileItems(client, workspaceId, [record.itemId]);
  }
  throwIfAborted(signal);
  if (!record.current.previewable) {
    throw new Error('Nix could not verify this file as a durable, previewable image.');
  }
  return record.itemId;
}

async function retireUploadedFileItems(
  client: NixClient,
  workspaceId: string,
  itemIds: readonly string[],
): Promise<readonly string[]> {
  let remaining = [...new Set(itemIds)];
  for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt += 1) {
    if (attempt > 0) await waitForRetirementRetry(attempt * 25);
    const outcomes = await Promise.allSettled(
      remaining.map((itemId) => client.execute(coreItems.deleteItem(workspaceId, itemId))),
    );
    remaining = remaining.filter((_, index) => outcomes[index]?.status === 'rejected');
  }
  if (remaining.length > 0) {
    console.warn(
      'A canvas upload created during a failed operation could not be retired.',
      remaining,
    );
  }
  return remaining;
}

async function waitForRetirementRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The canvas operation was aborted.', 'AbortError');
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function isEncodingError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'EncodingError';
}

async function canvasImageDimensions(
  file: File,
): Promise<{ readonly width: number; readonly height: number }> {
  const readBitmap: unknown = globalThis.createImageBitmap;
  if (typeof readBitmap !== 'function') return { width: 320, height: 240 };
  try {
    const bitmap = (await readBitmap.call(globalThis, file)) as ImageBitmap;
    const scale = Math.min(1, 640 / bitmap.width, 480 / bitmap.height);
    const dimensions = {
      width: Math.max(1, Math.round(bitmap.width * scale)),
      height: Math.max(1, Math.round(bitmap.height * scale)),
    };
    bitmap.close();
    return dimensions;
  } catch {
    return { width: 320, height: 240 };
  }
}

function hasUnownedCanvasImages(
  elements: readonly OrderedExcalidrawElement[],
  lastSafeElements: readonly OrderedExcalidrawElement[],
  pendingFileIds: ReadonlySet<FileId>,
  currentFiles: BinaryFiles,
  lastSafeFiles: BinaryFiles,
): boolean {
  const allowed = new Set<FileId>(pendingFileIds);
  for (const fileId of canvasFileItemIds(lastSafeElements)) allowed.add(fileId);
  for (const file of externalCanvasFiles(lastSafeElements)) allowed.add(file.id);
  return elements.some((element) => {
    if (element.isDeleted || element.type !== 'image' || element.fileId === null) {
      return false;
    }
    if (!allowed.has(element.fileId)) return true;
    if (pendingFileIds.has(element.fileId)) return false;
    const currentFile = currentFiles[element.fileId];
    if (currentFile === undefined) return false;
    const lastSafeFile = lastSafeFiles[element.fileId];
    return currentFile.dataURL !== lastSafeFile?.dataURL;
  });
}

/**
 * Import is a scene replacement, while the durable Y.Map is append-only by element ID. Retire
 * elements absent from the imported scene and lift colliding imported versions over the stored
 * ones so the binding cannot resurrect the scene that was deliberately replaced.
 */
function replaceImportedScene(
  current: readonly OrderedExcalidrawElement[],
  imported: readonly OrderedExcalidrawElement[],
): OrderedExcalidrawElement[] {
  const currentById = new Map(current.map((element) => [element.id, element]));
  const importedIds = new Set(imported.map((element) => element.id));
  const retired = current.flatMap((element) => {
    if (importedIds.has(element.id)) return [];
    return [element.isDeleted ? element : newElementWith(element, { isDeleted: true })];
  });
  const replacements = imported.map((element) => {
    const existing = currentById.get(element.id);
    if (existing === undefined || element.version > existing.version) return element;
    const bumped = newElementWith(element, {}, true);
    return { ...bumped, version: existing.version + 1 };
  });
  return [...retired, ...replacements];
}

function markSavedImages(
  elements: readonly OrderedExcalidrawElement[],
  savedFileIds: ReadonlySet<FileId>,
): { readonly elements: readonly OrderedExcalidrawElement[]; readonly changed: boolean } {
  let changed = false;
  const next = elements.map((element) => {
    if (element.type !== 'image' || element.fileId === null || !savedFileIds.has(element.fileId)) {
      return element;
    }
    const markedFileId = nixFileItemIdFromElement(element);
    if (element.status === 'saved' && markedFileId === element.fileId) return element;
    changed = true;
    return newElementWith(element, {
      status: 'saved',
      customData: withNixFileMetadata(element, element.fileId),
    });
  });
  return { elements: next, changed };
}

function publishSavedImageStatuses(
  api: ExcalidrawImperativeAPI,
  savedFileIds: ReadonlySet<FileId>,
  onChangeRef: { readonly current: (elements: readonly CanvasElement[]) => void },
  lastPublishedFingerprintRef: { current: string },
  suppressFingerprintRef: { current: string | null },
): void {
  const saved = markSavedImages(api.getSceneElementsIncludingDeleted(), savedFileIds);
  if (!saved.changed) return;
  const fingerprint = sceneFingerprint(saved.elements);
  suppressFingerprintRef.current = fingerprint;
  lastPublishedFingerprintRef.current = fingerprint;
  api.updateScene({ elements: saved.elements, captureUpdate: CaptureUpdateAction.NEVER });
  onChangeRef.current(saved.elements);
}

function filesById(files: readonly BinaryFileData[]): BinaryFiles {
  return Object.fromEntries(files.map((file) => [file.id, file]));
}

function mergeCanvasFiles(current: BinaryFiles, additions: readonly BinaryFileData[]): BinaryFiles {
  return additions.length === 0 ? current : { ...current, ...filesById(additions) };
}

function consumePendingImageIds(
  elements: readonly OrderedExcalidrawElement[],
  pendingFileIds: Set<FileId>,
): void {
  for (const element of elements) {
    if (element.type === 'image' && element.fileId !== null) {
      pendingFileIds.delete(element.fileId);
    }
  }
}

/**
 * Removes the temporary local exceptions that Excalidraw's reconciler makes for an element being
 * edited. The shared map uses the same version/nonce rule, so this is the scene that can actually
 * be committed once the gesture ends.
 */
function durableSceneWinners(
  reconciled: readonly OrderedExcalidrawElement[],
  incoming: readonly OrderedExcalidrawElement[],
): OrderedExcalidrawElement[] {
  const localById = new Map(reconciled.map((element) => [element.id, element]));
  const incomingIds = new Set(incoming.map((element) => element.id));
  const winners = incoming.map((remote) => {
    const local = localById.get(remote.id);
    return local !== undefined && supersedes(local, remote) ? local : remote;
  });
  for (const local of reconciled) {
    if (!incomingIds.has(local.id)) winners.push(local);
  }
  // The reconciler repairs fractional ordering. Keeping the incoming array order would make
  // updateScene repair it back on every echo, producing an unbounded render/publish loop.
  return winners.sort((left, right) => {
    const a = left.index;
    const b = right.index;
    return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
  });
}

function isActivelyEditingCanvas(
  appState: Pick<AppState, 'editingTextElement' | 'newElement' | 'resizingElement'>,
): boolean {
  return (
    appState.editingTextElement !== null ||
    appState.newElement !== null ||
    appState.resizingElement !== null
  );
}

function fileExtension(mimeType: BinaryFileData['mimeType']): string {
  if (mimeType === 'image/svg+xml') return 'svg';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/avif') return 'avif';
  return 'png';
}

function canvasImageMimeType(value: string): BinaryFileData['mimeType'] | null {
  const supported = new Set<string>(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);
  return supported.has(value) ? (value as BinaryFileData['mimeType']) : null;
}

/** Decode embedded Excalidraw image bytes without a fetch that production CSP would block. */
function canvasDataUrlToBlob(
  dataUrl: BinaryFileData['dataURL'],
  mimeType: BinaryFileData['mimeType'],
): Blob {
  const match = /^data:[^,]*?(;base64)?,(.*)$/su.exec(dataUrl);
  if (match === null) throw new Error('The imported canvas contains invalid image data.');
  const payload = match[2] ?? '';
  if (match[1] === ';base64') {
    const decoded = globalThis.atob(payload.replace(/\s/gu, ''));
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new Blob([bytes], { type: mimeType });
  }
  return new Blob([new TextEncoder().encode(decodeURIComponent(payload))], { type: mimeType });
}

function localCanvasAwareness(awareness: Awareness | undefined): Record<string, unknown> {
  if (awareness === undefined) return {};
  const localState: unknown = awareness.getLocalState();
  const canvas = isRecord(localState) ? localState.canvas : undefined;
  return isRecord(canvas) ? canvas : {};
}

function useAwarenessSnapshot(awareness: Awareness | undefined): string {
  return useSyncExternalStore(
    useCallback(
      (onStoreChange) => {
        if (awareness === undefined) return () => undefined;
        awareness.on('change', onStoreChange);
        return () => {
          awareness.off('change', onStoreChange);
        };
      },
      [awareness],
    ),
    () => JSON.stringify(readCollaborators(awareness)),
    () => '[]',
  );
}

function readCollaborators(awareness: Awareness | undefined): readonly [string, Collaborator][] {
  if (awareness === undefined) return [];
  const peers: [string, Collaborator][] = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID || !isRecord(state)) continue;
    const user = isRecord(state.user) ? state.user : {};
    const canvas = isRecord(state.canvas) ? state.canvas : {};
    const pointer: Collaborator['pointer'] =
      isRecord(canvas.pointer) &&
      typeof canvas.pointer.x === 'number' &&
      typeof canvas.pointer.y === 'number' &&
      (canvas.pointer.tool === 'pointer' || canvas.pointer.tool === 'laser')
        ? {
            x: canvas.pointer.x,
            y: canvas.pointer.y,
            tool: canvas.pointer.tool,
          }
        : undefined;
    const color = collaboratorColor(clientId);
    peers.push([
      String(clientId),
      {
        id: String(clientId),
        socketId: String(clientId) as SocketId,
        username: typeof user.name === 'string' ? user.name : 'Someone',
        color,
        ...(pointer === undefined ? {} : { pointer }),
        ...(canvas.button === 'down' || canvas.button === 'up' ? { button: canvas.button } : {}),
        ...(isRecord(canvas.selectedElementIds)
          ? { selectedElementIds: booleanRecord(canvas.selectedElementIds) }
          : {}),
      },
    ]);
  }
  return peers.sort(([left], [right]) => left.localeCompare(right));
}

function collaboratorColor(clientId: number): NonNullable<Collaborator['color']> {
  const tokens =
    COLLABORATOR_COLOR_TOKENS[Math.abs(clientId) % COLLABORATOR_COLOR_TOKENS.length] ??
    COLLABORATOR_COLOR_TOKENS[0];
  const readStyles: unknown = globalThis.getComputedStyle;
  if (typeof readStyles !== 'function') {
    return { background: 'Canvas', stroke: 'CanvasText' };
  }
  const styles = readStyles.call(globalThis, document.documentElement) as CSSStyleDeclaration;
  return {
    background: styles.getPropertyValue(tokens.background).trim() || 'Canvas',
    stroke: styles.getPropertyValue(tokens.stroke).trim() || 'CanvasText',
  };
}

function collaboratorsFromSnapshot(snapshot: string): Map<SocketId, Collaborator> {
  const entries = JSON.parse(snapshot) as readonly [string, Collaborator][];
  return new Map(entries.map(([id, collaborator]) => [id as SocketId, collaborator]));
}

function booleanRecord(value: Record<string, unknown>): Record<string, true> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, true] => entry[1] === true),
  );
}

function useCanvasGround(): Ground {
  return useSyncExternalStore(subscribeToGround, readGround, () => 'light');
}

function subscribeToGround(onStoreChange: () => void): () => void {
  const root = document.documentElement;
  const observer = new MutationObserver(onStoreChange);
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const media = themeMediaQuery();
  media?.addEventListener('change', onStoreChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onStoreChange);
  };
}

function readGround(): Ground {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return themeMediaQuery()?.matches === true ? 'dark' : 'light';
}

function themeMediaQuery(): MediaQueryList | null {
  const query: unknown = globalThis.matchMedia;
  return typeof query === 'function'
    ? (query.call(globalThis, '(prefers-color-scheme: dark)') as MediaQueryList)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
