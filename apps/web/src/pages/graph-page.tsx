import { isNixApiError, items as coreItems, type GraphNode } from '@nix/api-client';
import { Button, Select, Text } from '@nix/ui';
import type { ReactElement, ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';

import {
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  PartialNotice,
} from '@nix/web-foundation/components/states/status-panels';
import { GraphExplorer } from '../graph/graph-explorer';
import {
  GRAPH_OPEN_MODE_LABELS,
  GraphOpenModeSchema,
  useGraphOpenPreference,
} from '../graph/graph-open-preference';
import { useItemDialog } from '@nix/web-foundation/lib/item-dialog-context';
import { useWorkspaceGraph } from '../graph/use-workspace-graph';
import { paneScroller } from '@nix/web-foundation/layout/regions';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { notifyItemChildrenChanged } from '@nix/web-foundation/lib/item-children-changed';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { offerReference } from '@nix/web-foundation/lib/pending-reference';
import { useOpenItem } from '../tabs/use-open-item';
import { resolveOpenMode } from '../views/core/open-policy';

/**
 * The graph destination: the workspace as items and the references between them.
 *
 * **The truncation notice is the part that is not decoration.** Core bounds the response at 2,000
 * nodes and 4,000 links and reports whether it hit either ceiling. A truncated list looks short and
 * announces itself; a truncated graph looks like a graph. A reader shown 2,000 of 3,000 items would
 * conclude two clusters are unconnected, which is a wrong answer rather than a missing one - so
 * whenever a flag is set this page says so above the drawing, and says which ceiling was hit.
 *
 * Opening a node follows the "Open items in" setting: by default the full item appears in a dialog
 * while the graph stays mounted, and the other modes change the workspace destination.
 */
/**
 * The destination's frame: its heading, and whatever state it is in.
 *
 * The heading is outside the state fork on purpose. It is the answer to "where am I", which is
 * true while the graph is loading, true when it failed, and true when the workspace is empty - and
 * a destination that only names itself once it has data leaves a reader on an untitled page in
 * exactly the moments they most need to know where they landed.
 */
function GraphFrame({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className={`${paneScroller} flex flex-col gap-3 p-3 sm:gap-4 sm:p-4`}>
      <Text variant="h5" as="h1">
        Graph
      </Text>
      {children}
    </div>
  );
}

/** What a node is called in a sentence. The same placeholder the drawing uses. */
function titleOf(node: GraphNode | undefined): string {
  return node?.title !== undefined && node.title !== null && node.title.length > 0
    ? node.title
    : 'Untitled';
}

/** Why a move was refused, in the words the sidebar uses for the same refusals. */
function moveRefusal(reason: unknown): string {
  if (isNixApiError(reason) && reason.code === 'items.move_would_create_cycle') {
    return 'An item cannot be moved inside itself.';
  }
  if (isNixApiError(reason) && reason.code === 'items.locked') {
    return 'Unlock the locked item first. Nothing can be moved into or out of it while it is locked.';
  }
  if (isNixApiError(reason) && (reason.status === 403 || reason.status === 404)) {
    return 'You cannot move that item there.';
  }
  return 'The move could not be confirmed. Check the workspace before retrying.';
}

export function GraphPage(): ReactElement {
  const [searchParams] = useSearchParams();
  const { status, graph, error, reload, refresh } = useWorkspaceGraph();
  const { openPreview, openPinned } = useOpenItem();
  const openDialog = useItemDialog();
  const narrow = useNarrowViewport();
  const openMode = useGraphOpenPreference((state) => state.mode);
  const setOpenMode = useGraphOpenPreference((state) => state.setMode);
  // The same policy a saved view uses. The graph route has no pane to open beside, so that mode
  // is not offered and resolves to a dialog here.
  const dialogOrPage = openDialog ?? openPreview;
  const open = {
    page: openPreview,
    dialog: dialogOrPage,
    beside: dialogOrPage,
    tab: openPinned,
    none: dialogOrPage,
  }[resolveOpenMode({ view: { kind: 'graph', open: openMode }, narrow, canOpenBeside: false })];
  const client = useApiClient();

  /**
   * Moves an item inside another, from a drop the reader has confirmed.
   *
   * The graph is read again afterwards rather than patched: a move changes the layout of
   * everything around it, and the server's answer is the only one that includes what else changed
   * meanwhile. Undo is offered only when the old parent is known - on a truncated graph a null
   * parent can mean "its parent was not drawn", and undoing to the workspace root would then be a
   * second move rather than a reversal.
   */
  const move = async (itemId: string, parentId: string, undoing = false): Promise<void> => {
    if (graph === null) {
      return;
    }
    const node = graph.nodes.find((candidate) => candidate.id === itemId);
    const destination = graph.nodes.find((candidate) => candidate.id === parentId);
    const previous = node?.parentId ?? null;

    try {
      await client.execute(
        coreItems.moveItem(graph.workspaceId, itemId, { parentId, afterId: null }),
      );
    } catch (reason) {
      publishNotice({ key: `graph-move-refused:${itemId}`, message: moveRefusal(reason) });
      return;
    }

    notifyItemChildrenChanged(graph.workspaceId, parentId);
    notifyItemChildrenChanged(graph.workspaceId, previous);
    publishNotice({
      key: `graph-move:${itemId}:${parentId}`,
      message: `Moved "${titleOf(node)}" inside "${titleOf(destination)}".`,
      ...(undoing || previous === null
        ? {}
        : {
            action: {
              label: 'Undo',
              onAction: () => {
                void move(itemId, previous, true);
              },
            },
          }),
    });
    await refresh();
  };

  /**
   * Answers a link drawn from one node to another.
   *
   * A reference lives in the source item's body, so it is not written from here. The request is
   * left for the source's editor and the source is opened; the reader places it. Only a note has a
   * body that can hold one, so anything else is refused here, before opening something that could
   * not finish the job.
   */
  const link = (sourceId: string, targetId: string): void => {
    const source = graph?.nodes.find((candidate) => candidate.id === sourceId);
    const target = graph?.nodes.find((candidate) => candidate.id === targetId);
    if (source === undefined || target === undefined) {
      return;
    }

    if (source.type !== 'note') {
      publishNotice({
        key: `graph-link-refused:${sourceId}`,
        message: `Only a note can hold a reference, and "${titleOf(source)}" is not one. Draw the link from the note instead.`,
      });
      return;
    }

    offerReference({ sourceId, targetId, label: titleOf(target) });
    (openDialog ?? openPreview)(sourceId);
  };

  if (status === 'loading') {
    return (
      <GraphFrame>
        <LoadingPanel label="the workspace graph" />
      </GraphFrame>
    );
  }

  if (status === 'error' || graph === null) {
    return (
      <GraphFrame>
        <ErrorPanel
          title="The graph could not be loaded"
          detail={error ?? 'Something went wrong reading this workspace.'}
          action={
            <Button
              onClick={() => {
                void reload();
              }}
            >
              Try again
            </Button>
          }
        />
      </GraphFrame>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <GraphFrame>
        <EmptyPanel
          title="Nothing to graph yet"
          detail="This workspace has no items you can read. Create a note, and it will appear here with anything it links to."
        />
      </GraphFrame>
    );
  }

  return (
    <GraphFrame>
      {graph.nodesTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(graph.nodeLimit)} items in this workspace. Some items, and any references to them, are not drawn.`}
        />
      )}
      {graph.linksTruncated && (
        <PartialNotice
          pending={`Showing the first ${String(graph.linkLimit)} references. Some connections between the items below are not drawn.`}
        />
      )}

      <label className="flex min-w-0 max-w-full flex-col gap-1 self-start">
        <Text as="span" variant="caption">
          Open items in
        </Text>
        <Select
          value={openMode}
          onChange={(event) => {
            const parsed = GraphOpenModeSchema.safeParse(event.target.value);
            if (parsed.success) setOpenMode(parsed.data);
          }}
        >
          {GraphOpenModeSchema.options.map((mode) => (
            <option key={mode} value={mode}>
              {GRAPH_OPEN_MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </label>

      <GraphExplorer
        initialFocusId={searchParams.get('focus')}
        workspaceId={graph.workspaceId}
        onMove={(itemId, parentId) => {
          void move(itemId, parentId);
        }}
        onLink={link}
        nodes={graph.nodes}
        links={graph.links}
        onOpen={open}
        partial={graph.nodesTruncated || graph.linksTruncated}
      />
    </GraphFrame>
  );
}
