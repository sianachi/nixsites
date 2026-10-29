import type { GraphLink, GraphNode } from '@nix/api-client';
import { Button, ContextMenu, Input, Select, Text, focusRing } from '@nix/ui';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';
import { useHiddenItems } from '@nix/web-collections/items/use-hidden-items';
import { GraphView } from './graph-view';
import {
  readGraphPresentation,
  writeGraphPresentation,
  type GraphPresentation,
} from './graph-presentation';
import { GRAPH_REPRESENTATIONS, type GraphRepresentation } from './graph-representations';

interface Connection {
  id: string;
  relation: string;
}
export function graphConnections(
  nodes: readonly GraphNode[],
  links: readonly GraphLink[],
): Map<string, Connection[]> {
  const connections = new Map(nodes.map((node) => [node.id, [] as Connection[]]));
  function add(from: string, to: string, relation: string): void {
    if (connections.has(to)) connections.get(from)?.push({ id: to, relation });
  }
  for (const node of nodes)
    if (node.parentId) {
      add(node.id, node.parentId, 'Inside');
      add(node.parentId, node.id, 'Contains');
    }
  for (const link of links) {
    add(link.sourceId, link.targetId, 'Links to');
    add(link.targetId, link.sourceId, 'Linked from');
  }
  return connections;
}

export function GraphExplorer(props: Parameters<typeof WorkspaceGraphExplorer>[0]): ReactNode {
  return (
    <WorkspaceGraphExplorer
      key={`${props.workspaceId ?? ''}:${props.initialFocusId ?? ''}`}
      {...props}
    />
  );
}

function WorkspaceGraphExplorer({
  nodes: allNodes,
  links: allLinks,
  onOpen,
  partial = false,
  workspaceId,
  onMove,
  onLink,
  initialFocusId = null,
}: {
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  readonly onOpen: (itemId: string) => void;

  /** Whether the server hit a ceiling, so counts and replays cover part of the workspace. */
  readonly partial?: boolean;

  /** The workspace drawn, so the reader's arrangement of it can be kept on this device. */
  readonly workspaceId?: string | undefined;
  readonly onMove?: ((itemId: string, parentId: string) => void) | undefined;
  readonly onLink?: ((sourceId: string, targetId: string) => void) | undefined;
  readonly initialFocusId?: string | null;
}): ReactNode {
  const visibility = useHiddenItems();
  // GraphView's simulation consumes array identity: rebuild only for graph or visibility changes.
  const nodes = useMemo(
    () => allNodes.filter((node) => !visibility.hiddenSet.has(node.id)),
    [allNodes, visibility.hiddenSet],
  );
  const links = useMemo(() => {
    const ids = new Set(nodes.map((node) => node.id));
    return allLinks.filter((link) => ids.has(link.sourceId) && ids.has(link.targetId));
  }, [allLinks, nodes]);
  const narrow = useNarrowViewport();
  const initialFocus = nodes.find((node) => node.id === initialFocusId);
  const [pendingFocusId, setPendingFocusId] = useState(
    initialFocus === undefined ? initialFocusId : null,
  );
  const [choice, setChoice] = useState<'browse' | 'spatial' | null>(
    initialFocus ? 'spatial' : null,
  );
  const [visitedSpatial, setVisitedSpatial] = useState(!narrow || initialFocus !== undefined);
  const mode = choice ?? (narrow ? 'browse' : 'spatial');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const [reveal, setReveal] = useState<{ id: string; token: number } | null>(
    initialFocus === undefined ? null : { id: initialFocus.id, token: 1 },
  );
  const [presentation, setPresentation] = useState<GraphPresentation>(() =>
    initialFocus === undefined
      ? readGraphPresentation(workspaceId)
      : { representation: 'focused', focusId: initialFocus.id, distance: 1 },
  );
  const focusId = nodes.some((node) => node.id === presentation.focusId)
    ? presentation.focusId
    : (nodes.find((node) => node.parentId !== null)?.id ?? nodes[0]?.id ?? null);
  useEffect(() => {
    writeGraphPresentation(workspaceId, presentation);
  }, [workspaceId, presentation]);
  const spatialRef = useRef<HTMLDivElement | null>(null);
  const searchId = useId();
  useEffect(() => {
    if (reveal !== null) {
      spatialRef.current?.scrollIntoView({ block: 'start' });
      spatialRef.current?.focus({ preventScroll: true });
    }
  }, [reveal]);
  // The graph can contain 2,000 nodes and 4,000 edges. Index only when server data changes,
  // not on each search keystroke or disclosure toggle.
  const connections = useMemo(() => graphConnections(nodes, links), [nodes, links]);
  const titles = new Map(
    nodes.map((node) => [node.id, node.title?.trim() ? node.title : 'Untitled']),
  );
  const matches = nodes.filter((node) =>
    (node.title?.trim() ? node.title : 'Untitled')
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  const focusInGraph = (id: string): void => {
    setPendingFocusId(null);
    setPresentation({ representation: 'focused', focusId: id, distance: 1 });
    setChoice('spatial');
    setVisitedSpatial(true);
    setSearch('');
    setReveal((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  if (pendingFocusId !== null && initialFocus?.id === pendingFocusId) {
    focusInGraph(pendingFocusId);
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {initialFocusId !== null &&
      initialFocus === undefined &&
      (pendingFocusId !== null || presentation.focusId === initialFocusId) ? (
        <Text variant="caption" tone="muted" role="status">
          This item is not in the visible graph. It may be hidden, unavailable, or outside the
          loaded portion of the workspace.
        </Text>
      ) : null}
      {nodes.length < allNodes.length ? (
        <Text variant="caption" tone="muted" role="status">
          {String(allNodes.length - nodes.length)} hidden
        </Text>
      ) : null}
      <label htmlFor={searchId} className="flex min-w-0 flex-col gap-2">
        <Text as="span" variant="caption">
          Find an item
        </Text>
        <Input
          id={searchId}
          type="search"
          placeholder="Search item titles"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(50);
          }}
        />
      </label>
      {mode === 'spatial' && search.trim().length > 0 ? (
        <section aria-label="Graph search results" className="flex min-w-0 flex-col gap-2">
          <Text as="p" variant="caption" tone="muted" role="status">
            {String(matches.length)} matching items{partial ? ' in the loaded portion' : ''}. Choose
            an item to focus its connections.
          </Text>
          <ul className="flex min-w-0 flex-col gap-1">
            {matches.slice(0, 10).map((node) => (
              <li key={node.id} className="min-w-0">
                <Button
                  variant="ghost"
                  className="h-auto min-h-(--control-md) w-full justify-start break-all whitespace-normal text-left"
                  aria-label={`Focus graph on ${titles.get(node.id) ?? 'Untitled'}`}
                  onClick={() => {
                    focusInGraph(node.id);
                  }}
                >
                  {titles.get(node.id)}
                </Button>
              </li>
            ))}
          </ul>
          {matches.length > 10 ? (
            <Button
              variant="ghost"
              onClick={() => {
                setChoice('browse');
              }}
            >
              Browse all matching items
            </Button>
          ) : null}
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2" aria-label="Graph presentation">
        <Button
          variant="ghost"
          aria-pressed={mode === 'browse'}
          onClick={() => {
            setChoice('browse');
          }}
        >
          Browse connections
        </Button>
        <Button
          variant="ghost"
          aria-pressed={mode === 'spatial'}
          onClick={() => {
            setChoice('spatial');
            setVisitedSpatial(true);
          }}
        >
          Spatial graph
        </Button>
      </div>
      {mode === 'spatial' || visitedSpatial ? (
        <div
          ref={spatialRef}
          hidden={mode !== 'spatial'}
          role="region"
          aria-label="Spatial graph"
          tabIndex={-1}
          className={focusRing}
        >
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 max-w-full flex-col gap-1">
              <Text as="span" variant="caption">
                Graph layout
              </Text>
              <Select
                value={presentation.representation}
                onChange={(event) => {
                  const value = event.target.value;
                  const representation = Object.keys(GRAPH_REPRESENTATIONS).find(
                    (candidate): candidate is GraphRepresentation => candidate === value,
                  );
                  if (representation === undefined) return;
                  setPendingFocusId(null);
                  setPresentation((current) => ({ ...current, representation }));
                  setReveal(null);
                }}
              >
                {Object.entries(GRAPH_REPRESENTATIONS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
            {presentation.representation === 'focused' ? (
              <>
                <label className="flex min-w-0 max-w-full flex-col gap-1">
                  <Text as="span" variant="caption">
                    Focus item
                  </Text>
                  <Select
                    value={focusId ?? ''}
                    disabled={nodes.length === 0}
                    onChange={(event) => {
                      setPendingFocusId(null);
                      setPresentation((current) => ({ ...current, focusId: event.target.value }));
                      setReveal(null);
                    }}
                  >
                    {nodes.length === 0 ? (
                      <option value="">No items</option>
                    ) : (
                      nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {titles.get(node.id)}
                        </option>
                      ))
                    )}
                  </Select>
                </label>
                <label className="flex min-w-0 max-w-full flex-col gap-1">
                  <Text as="span" variant="caption">
                    Connection distance
                  </Text>
                  <Select
                    value={presentation.distance}
                    onChange={(event) => {
                      setPendingFocusId(null);
                      setPresentation((current) => ({
                        ...current,
                        distance: Number(event.target.value),
                      }));
                      setReveal(null);
                    }}
                  >
                    {[1, 2, 3, 4, 5].map((distance) => (
                      <option key={distance} value={distance}>
                        {String(distance)} {distance === 1 ? 'step' : 'steps'}
                      </option>
                    ))}
                  </Select>
                </label>
              </>
            ) : null}
          </div>
          <GraphView
            // Remounted per workspace: its arrangement is read once, when it mounts.
            key={workspaceId}
            workspaceId={workspaceId}
            onMove={onMove}
            onLink={onLink}
            nodes={nodes}
            links={links}
            onOpen={onOpen}
            reveal={reveal}
            partial={partial}
            representation={presentation.representation}
            focusId={focusId}
            distance={presentation.distance}
          />
        </div>
      ) : null}
      <section
        hidden={mode !== 'browse'}
        aria-label="Graph connections"
        className="flex flex-col gap-3"
      >
        <Text as="p" variant="caption" tone="muted" role="status">
          {String(matches.length)} matching items{partial ? ' in the loaded portion' : ''}
        </Text>
        <ul className="divide-y divide-divider">
          {matches.slice(0, limit).map((node) => {
            const related = connections.get(node.id) ?? [];
            const title = titles.get(node.id) ?? 'Untitled';
            const showInGraph = (): void => {
              setPendingFocusId(null);
              setChoice('spatial');
              setVisitedSpatial(true);
              if (presentation.representation === 'focused') {
                setPresentation((current) => ({ ...current, focusId: node.id }));
              }
              setReveal((current) => ({ id: node.id, token: (current?.token ?? 0) + 1 }));
            };
            return (
              <li key={node.id} className="min-w-0 py-3">
                <ContextMenu
                  label={`${title} actions`}
                  items={[
                    {
                      label: 'Open',
                      onSelect: () => {
                        onOpen(node.id);
                      },
                    },
                    { label: 'Show in graph', onSelect: showInGraph },
                    {
                      label: 'Focus in graph',
                      onSelect: () => {
                        focusInGraph(node.id);
                      },
                    },
                  ]}
                >
                  {(target) => (
                    <Button
                      {...target}
                      variant="ghost"
                      className="h-auto min-h-(--control-md) w-full justify-start break-all whitespace-normal text-left pointer-coarse:min-h-(--control-lg)"
                      onClick={() => {
                        onOpen(node.id);
                      }}
                    >
                      {title}
                    </Button>
                  )}
                </ContextMenu>
                <Button
                  variant="ghost"
                  aria-label={`Show ${titles.get(node.id) ?? 'Untitled'} in graph`}
                  onClick={showInGraph}
                >
                  Show in graph
                </Button>
                <Button
                  variant="ghost"
                  aria-label={`Focus graph on ${titles.get(node.id) ?? 'Untitled'}`}
                  onClick={() => {
                    focusInGraph(node.id);
                  }}
                >
                  Focus in graph
                </Button>
                {related.length === 0 ? (
                  <Text as="p" variant="caption" tone="muted">
                    No connections in this graph.
                  </Text>
                ) : (
                  <details>
                    <summary className="cursor-default py-2">
                      {String(related.length)} connections
                    </summary>
                    <ul className="border-l border-divider pl-3">
                      {related.map((connection, index) => (
                        <li
                          key={`${connection.relation}:${connection.id}:${String(index)}`}
                          className="flex flex-wrap items-center gap-1"
                        >
                          <Text as="span" variant="caption" tone="muted">
                            {connection.relation}
                          </Text>
                          <Button
                            variant="ghost"
                            className="h-auto min-h-(--control-md) min-w-0 max-w-full break-all whitespace-normal text-left pointer-coarse:min-h-(--control-lg)"
                            onClick={() => {
                              onOpen(connection.id);
                            }}
                          >
                            {titles.get(connection.id)}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
        {matches.length > limit ? (
          <Button
            variant="secondary"
            onClick={() => {
              setLimit((current) => current + 50);
            }}
          >
            Show more items
          </Button>
        ) : null}
      </section>
    </div>
  );
}
