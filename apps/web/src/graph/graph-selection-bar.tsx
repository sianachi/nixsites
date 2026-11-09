import type { GraphLink, GraphNode } from '@nix/api-client';
import { Button, Select, Text } from '@nix/ui';
import { useMemo, type ReactElement } from 'react';

/** What a body kind is called in the legend, the filter and here. */
export function kindLabel(type: string): string {
  return type.length === 0 ? 'Unknown' : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function titleOf(node: GraphNode): string {
  return node.title !== null && node.title.trim().length > 0 ? node.title : 'Untitled';
}

/** Every item a move of `node` could not land on: itself and anything beneath it. */
function withDescendants(node: GraphNode, nodes: readonly GraphNode[]): Set<string> {
  const parentOf = new Map(nodes.map((candidate) => [candidate.id, candidate.parentId]));
  const excluded = new Set([node.id]);
  for (const candidate of nodes) {
    const seen = new Set<string>();
    for (
      let above = parentOf.get(candidate.id);
      above !== null && above !== undefined && !seen.has(above);
      above = parentOf.get(above)
    ) {
      if (above === node.id) {
        excluded.add(candidate.id);
        break;
      }
      seen.add(above);
    }
  }
  return excluded;
}

/**
 * The selected node's actions as ordinary controls: open, focus, move into, link to.
 *
 * The same moves and links a drag makes, for anyone who cannot or would rather not drag (touch,
 * keyboard, a trackpad). Its choices are built only while a node is selected, so a large graph
 * pays for them once per selection rather than per node drawn.
 */
export function GraphSelectionBar({
  node,
  nodes,
  links,
  onOpen,
  onFocus,
  onMove,
  onLink,
  onClose,
}: {
  readonly node: GraphNode;
  readonly nodes: readonly GraphNode[];
  readonly links: readonly GraphLink[];
  readonly onOpen: (itemId: string) => void;
  readonly onFocus?: ((itemId: string) => void) | undefined;
  readonly onMove?: ((itemId: string, parentId: string) => void) | undefined;
  readonly onLink?: ((sourceId: string, targetId: string) => void) | undefined;
  readonly onClose: () => void;
}): ReactElement {
  const moveTargets = useMemo(() => {
    const excluded = withDescendants(node, nodes);
    return nodes.filter(
      (candidate) => !excluded.has(candidate.id) && candidate.id !== node.parentId,
    );
  }, [node, nodes]);
  const linkTargets = useMemo(() => {
    const linked = new Set(
      links.flatMap((link) =>
        link.sourceId === node.id
          ? [link.targetId]
          : link.targetId === node.id
            ? [link.sourceId]
            : [],
      ),
    );
    return nodes.filter((candidate) => candidate.id !== node.id && !linked.has(candidate.id));
  }, [node, nodes, links]);
  const option = (candidate: GraphNode): ReactElement => (
    <option key={candidate.id} value={candidate.id}>
      {`${titleOf(candidate)} (${kindLabel(candidate.type)})`}
    </option>
  );

  return (
    <div
      role="region"
      aria-label="Selected item"
      className="sticky bottom-0 z-10 flex flex-col gap-2 rounded-md border border-divider bg-background p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Text as="span" variant="note" className="min-w-0 break-all">
          {titleOf(node)}
        </Text>
        <Text as="span" variant="caption" tone="muted">
          {kindLabel(node.type)}
        </Text>
        <Button
          variant="secondary"
          onClick={() => {
            onOpen(node.id);
          }}
        >
          Open
        </Button>
        {onFocus !== undefined && (
          <Button
            variant="subtle"
            onClick={() => {
              onFocus(node.id);
            }}
          >
            Focus connections
          </Button>
        )}
        <Button variant="subtle" onClick={onClose}>
          Deselect
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onMove !== undefined && (
          <Select
            aria-label="Move into"
            value=""
            onChange={(event) => {
              if (event.target.value !== '') onMove(node.id, event.target.value);
            }}
          >
            <option value="">Move into...</option>
            {moveTargets.map(option)}
          </Select>
        )}
        {onLink !== undefined &&
          (node.type === 'note' ? (
            <Select
              aria-label="Link to"
              value=""
              onChange={(event) => {
                if (event.target.value !== '') onLink(node.id, event.target.value);
              }}
            >
              <option value="">Link to...</option>
              {linkTargets.map(option)}
            </Select>
          ) : (
            <Text as="span" variant="caption" tone="muted">
              Only a note can hold a link.
            </Text>
          ))}
      </div>
    </div>
  );
}
