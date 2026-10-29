import { Button, Icon, Text, cn, type MenuEntry } from '@nix/ui';
import { Download, Upload } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
} from '@nix/web-foundation/components/states/status-panels';
import {
  ShownItems,
  useOptionalItemSelection,
} from '../../collections/core/item-selection-context';
import { CreateItemControl } from '../core/create-item-control';
import { useItemContextActions } from '../../collections/core/use-item-context-actions';
import type { Item } from '../../collections/core/container-model';
import type { ViewRendererProps } from '../core/view-kinds';
import { isDriveContainerCandidate } from './drive-icons';
import { DriveDownloadAction } from './drive-download-action';
import { DriveGrid } from './drive-grid';
import { resolveLayout } from './drive-layout';
import { compareRows, type SortKey, type SortState } from './drive-sort';
import { DriveTable } from './drive-table';
import { useDriveFileInfo } from './use-drive-file-info';
import { useDriveTransfers } from './use-drive-transfers';

/**
 * The drive: a container's children as a file manager, list or grid.
 *
 * Issue #54's shape - a drive is a *view* over any container's children, not a kind of item, so
 * this component is exactly one more entry in `VIEW_KINDS` and touches nothing about what an item
 * can be. Two things every other view here does not need: it fetches file facts (size, media
 * type) itself, lazily, because `Item` does not carry them (`use-drive-file-info.ts`); and it is
 * the one view whose rows can be dragged into each other rather than only into the sidebar.
 */

export function DriveView(props: ViewRendererProps): ReactNode {
  const { container, view, onOpen } = props;
  const itemActions = useItemContextActions(onOpen);
  const selection = useOptionalItemSelection();
  const setTrayActions = selection?.setTrayActions;

  const layout = resolveLayout(view.layout);

  // Kept in component state, deliberately: the drive's other choices (columns, cover, grouping)
  // all persist to the view record through `structured-view-configuration.tsx`'s generic field
  // handling, but a sort typed here is a way of looking at this session's screenful rather than a
  // property of the view somebody else opens later. Persisting it is real future work - it would
  // want the same `sortBy`/`sortDescending` fields every other kind already stores - and is out of
  // scope for landing the kind itself.
  const [sort, setSort] = useState<SortState>({ key: 'name', direction: 'ascending' });

  const [status, setStatus] = useState<string | null>(null);
  const [dropTargetRoot, setDropTargetRoot] = useState(false);
  const [dropTargetRow, setDropTargetRow] = useState<string | null>(null);
  const [dragging, setDragging] = useState<readonly string[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fileItemIds = useMemo(
    () => container.children.filter((item) => item.type === 'file').map((item) => item.id),
    [container.children],
  );
  const fileInfo = useDriveFileInfo(fileItemIds);

  const rows = useMemo(
    () => [...container.children].sort((a, b) => compareRows(a, b, sort, fileInfo)),
    [container.children, sort, fileInfo],
  );

  function changeSort(key: SortKey): void {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
        : { key, direction: 'ascending' },
    );
  }
  const { downloadItems, uploadFiles, moveItems } = useDriveTransfers(container, setStatus);

  useEffect(() => {
    if (setTrayActions === undefined) return;
    setTrayActions(<DriveDownloadAction rows={rows} onDownload={downloadItems} />);
    return () => {
      setTrayActions(null);
    };
  }, [downloadItems, rows, setTrayActions]);

  function pickFiles(): void {
    fileInputRef.current?.click();
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const { files } = event.currentTarget;
    event.currentTarget.value = '';
    if (files !== null && files.length > 0) void uploadFiles(files);
  }

  function onRootDragOver(event: DragEvent<HTMLDivElement>): void {
    if (dragging !== null) return; // an internal row drag, not an OS file drop
    if (event.dataTransfer.types.includes('Files')) {
      event.preventDefault();
      setDropTargetRoot(true);
    }
  }

  function onRootDrop(event: DragEvent<HTMLDivElement>): void {
    setDropTargetRoot(false);
    if (dragging !== null) return;
    if (event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    void uploadFiles(event.dataTransfer.files);
  }

  function onRowDragStart(item: Item, event: DragEvent<HTMLElement>): void {
    const ids = selection?.selected.has(item.id) === true ? [...selection.selected] : [item.id];
    setDragging(ids);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ids.join(','));
  }

  function onRowDragEnd(): void {
    setDragging(null);
    setDropTargetRow(null);
  }

  function onRowDragOver(item: Item, event: DragEvent<HTMLElement>): void {
    if (dragging === null || !isDriveContainerCandidate(item) || dragging.includes(item.id)) return;
    event.preventDefault();
    setDropTargetRow(item.id);
  }

  function onRowDrop(item: Item, event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    const ids = dragging;
    setDragging(null);
    setDropTargetRow(null);
    if (ids === null || ids.includes(item.id) || !isDriveContainerCandidate(item)) return;
    void moveItems(ids, item.id);
  }

  function rowContextMenu(item: Item): MenuEntry[] {
    return itemActions(item.id, item.title, [
      ...(item.type === 'file'
        ? [
            {
              label: 'Download',
              icon: Download,
              onSelect: () => {
                void downloadItems([item]);
              },
            },
          ]
        : []),
    ]);
  }

  if (container.status === 'loading') return <LoadingPanel label="this drive" />;
  if (container.status === 'error')
    return (
      <ErrorPanel
        title="This drive could not be read"
        detail={container.error ?? 'Something went wrong reading this container.'}
      />
    );

  // Out of the tab order and the a11y tree: the Upload button is the control, and a focusable but
  // invisible input is a focus ring nobody can see. This is the one file input for the whole
  // drive, so it works from a phone, which has no drag-and-drop to fall back on.
  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      multiple
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      aria-label="Files to upload"
      onChange={onFileInputChange}
    />
  );
  const uploadButton = (
    <Button variant="secondary" onClick={pickFiles}>
      <Icon icon={Upload} size="sm" />
      Upload
    </Button>
  );

  return (
    <div
      className={cn(
        '@container/drive flex min-h-0 min-w-0 flex-col gap-3',
        dropTargetRoot && 'outline-2 -outline-offset-2 outline-accent',
      )}
      onDragOver={onRootDragOver}
      onDragLeave={() => {
        setDropTargetRoot(false);
      }}
      onDrop={onRootDrop}
    >
      {fileInput}

      {status !== null ? (
        <Text variant="note" tone="muted" role="status">
          {status}
        </Text>
      ) : null}

      {rows.length === 0 ? (
        <EmptyPanel
          title="Nothing in here yet"
          detail="Items added to this one, or files dropped onto this drive, appear here."
          action={
            <div className="flex flex-wrap gap-2">
              <CreateItemControl label="Add the first item" onCreate={container.create} />
              {uploadButton}
            </div>
          }
        />
      ) : (
        <>
          <ShownItems ids={rows.map((row) => row.id)} />

          {/* Above the list, so Upload is in reach on a phone without scrolling past every file. */}
          <div className="flex flex-wrap gap-2">
            <CreateItemControl label="Add an item" onCreate={container.create} />
            {uploadButton}
          </div>

          {layout === 'grid' ? (
            <DriveGrid
              rows={rows}
              fileInfo={fileInfo}
              dropTargetRow={dropTargetRow}
              onOpen={onOpen}
              rowContextMenu={rowContextMenu}
              onDragStart={onRowDragStart}
              onDragOver={onRowDragOver}
              onDragEnd={onRowDragEnd}
              onDrop={onRowDrop}
            />
          ) : (
            <DriveTable
              rows={rows}
              fileInfo={fileInfo}
              sort={sort}
              dropTargetRow={dropTargetRow}
              onOpen={onOpen}
              rowContextMenu={rowContextMenu}
              onChangeSort={changeSort}
              onDragStart={onRowDragStart}
              onDragOver={onRowDragOver}
              onDragEnd={onRowDragEnd}
              onDrop={onRowDrop}
            />
          )}
        </>
      )}
    </div>
  );
}
