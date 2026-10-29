import { Button, Text, cn, focusRing, inkWashStates } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';
import type { PreviewModel, PreviewNode } from '@nix/structure-spec';

function detailTone(detail: string): 'default' | 'muted' | 'accent' {
  if (detail.startsWith('Added ') || detail.startsWith('Now shown when ')) return 'accent';
  if (
    detail.startsWith('Removed ') ||
    detail.startsWith('Reworded ') ||
    detail.startsWith('No longer shown conditionally.')
  )
    return 'default';
  return 'muted';
}

function countValue(count: number, singular: string, plural = `${singular}s`): string | undefined {
  return count > 0 ? `${String(count)} ${count === 1 ? singular : plural}` : undefined;
}

export function PetStructurePreview({
  model,
  captureSummary = false,
  pending = false,
  children,
}: {
  readonly model: PreviewModel;
  readonly captureSummary?: boolean;
  /** True on a still-pending approval card: nothing here may fold behind a click, so tree nodes
   * never collapse to "Show N more", every "Why" stays open, and warnings stay expanded (security
   * fix S1). False (the default) is a post-decision receipt, where folding is fine. */
  readonly pending?: boolean;
  /** Detail of the change itself (a note body edit's before and after text), shown after the
   * notes and before the warnings, so a warning about it reads after the text it is about. */
  readonly children?: ReactNode;
}): ReactElement {
  const countsLine = captureSummary
    ? [
        countValue(model.counts.items, 'item to copy', 'items to copy'),
        countValue(model.counts.writes, 'template write', 'template writes'),
      ]
    : [
        countValue(model.counts.items, 'item'),
        countValue(model.counts.fields, 'field'),
        countValue(model.counts.views, 'view'),
        countValue(model.counts.entries, 'entry'),
        countValue(model.counts.writes, 'write'),
      ];
  const counts = countsLine.filter((value): value is string => value !== undefined);
  return (
    <div className="flex min-w-0 flex-col gap-2 wrap-anywhere">
      <Text variant="note" tone="muted">
        In: {model.destination.path.length ? model.destination.path.join(' / ') : 'Workspace root'}
        {counts.length ? ` · ${counts.join(', ')}` : ''}
      </Text>
      {model.tree.length ? (
        <ul className="list-disc space-y-2 pl-5">
          {model.tree.map((node, index) => (
            <PreviewTreeNode
              key={`${node.label}:${String(index)}`}
              node={node}
              depth={0}
              pending={pending}
            />
          ))}
        </ul>
      ) : null}
      {model.notes.length ? (
        <ul className="list-disc pl-5">
          {model.notes.map((note, index) => (
            <li key={`${note}:${String(index)}`}>
              <Text variant="note">{note}</Text>
            </li>
          ))}
        </ul>
      ) : null}
      {children}
      {model.warnings.length ? (
        <details open={pending || undefined}>
          <summary className={cn('cursor-default rounded', focusRing, inkWashStates)}>
            <Text variant="note" as="span">
              Worth knowing ({model.warnings.length})
            </Text>
          </summary>
          <ul className="list-disc pl-5">
            {model.warnings.map((warning, index) => (
              <li key={`${warning.path}:${String(index)}`}>
                <Text variant="note">
                  {warning.path}: {warning.message}
                </Text>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {model.problems.length ? (
        <div role="alert" className="flex flex-col gap-1">
          <Text variant="note">Cannot run</Text>
          <ul className="list-disc pl-5">
            {model.problems.map((problem, index) => (
              <li key={`${problem.path}:${String(index)}`}>
                <Text variant="note">
                  {problem.path}: {problem.message}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <Text variant="note" tone="muted">
        This never: {model.neverDoes.join('; ')}.
      </Text>
    </div>
  );
}

function countNodes(nodes: readonly PreviewNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);
}

function PreviewTreeNode({
  node,
  depth,
  pending,
}: {
  readonly node: PreviewNode;
  readonly depth: number;
  /** See `PetStructurePreview`'s `pending` prop: while true, this node never collapses behind
   * "Show N more" and its "Why" starts open, so a pending card shows the whole tree up front. */
  readonly pending: boolean;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = countNodes(node.children);
  const collapsed = !pending && depth >= 2 && hiddenCount > 0 && !expanded;
  return (
    <li className="space-y-1">
      <Text variant="body">{node.label}</Text>
      {node.detail.map((detail, index) => (
        <Text
          key={`${detail}:${String(index)}`}
          variant="note"
          tone={detailTone(detail)}
          className="block whitespace-pre-wrap break-words"
        >
          {detail}
        </Text>
      ))}
      {node.why ? (
        <details open={pending || undefined}>
          <summary className={cn('cursor-default rounded', focusRing, inkWashStates)}>
            <Text variant="note" as="span">
              Why
            </Text>
          </summary>
          <Text variant="note">{node.why}</Text>
        </details>
      ) : null}
      {collapsed ? (
        <Button
          variant="ghost"
          onClick={() => {
            setExpanded(true);
          }}
        >
          Show {hiddenCount} more
        </Button>
      ) : node.children.length ? (
        <ul className="list-disc space-y-2 pl-5">
          {node.children.map((child, index) => (
            <PreviewTreeNode
              key={`${child.label}:${String(index)}`}
              node={child}
              depth={depth + 1}
              pending={pending}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
