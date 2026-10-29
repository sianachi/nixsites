import { Button, Icon, Text } from '@nix/ui';
import { ChevronRight, ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkspaceTree } from './use-workspace-tree';

/** Browse one level at a time; every item is a valid structural destination. Core authorizes writes. */
export function MobileDestinationPicker({
  tree,
  parentId,
  onChange,
  disabled = false,
  purpose = 'create',
  excludedId,
  excludedIds,
}: {
  readonly tree: WorkspaceTree;
  readonly parentId: string | null;
  readonly onChange: (id: string | null) => void;
  readonly disabled?: boolean;
  readonly purpose?: 'create' | 'move';
  readonly excludedId?: string;
  /** Several items on the move at once: none of them is a destination. */
  readonly excludedIds?: ReadonlySet<string>;
}): ReactNode {
  const parent = parentId === null ? null : tree.find(parentId);
  const loading =
    tree.status === 'loading' || (parentId !== null && tree.isLoadingChildren(parentId));
  return (
    <section aria-label="Destination" className="flex min-h-0 min-w-0 flex-col gap-2">
      <Text as="p" variant="bodySmall">
        {purpose === 'create' ? 'Create in:' : 'Move to:'}{' '}
        {parentId === null ? 'Workspace' : (parent?.title ?? '') || 'Untitled'}
      </Text>
      {parentId !== null ? (
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            onChange(parent?.parentId ?? null);
          }}
        >
          <Icon icon={ArrowLeft} size="sm" /> Up one level
        </Button>
      ) : null}
      {loading ? (
        <Text variant="note" role="status">
          Loading destinations…
        </Text>
      ) : null}
      {tree.error ? (
        <Text variant="note" role="alert">
          {tree.error}
        </Text>
      ) : null}
      <div className="max-h-48 overflow-y-auto overscroll-contain rounded-md border border-divider">
        {tree
          .childrenOf(parentId)
          .filter((item) => item.id !== excludedId && excludedIds?.has(item.id) !== true)
          .map((item) => (
            <Button
              key={item.id}
              variant="ghost"
              disabled={disabled}
              className="min-w-0 w-full justify-between text-left"
              onClick={() => {
                onChange(item.id);
                void tree.expand(item.id);
              }}
            >
              <Text as="span" variant="bodySmall" className="min-w-0 truncate">
                {item.title || 'Untitled'}
              </Text>
              <Icon icon={ChevronRight} size="sm" className="shrink-0" />
            </Button>
          ))}
        {!loading && !tree.error && tree.childrenOf(parentId).length === 0 ? (
          <Text as="p" variant="note" tone="muted" className="p-3">
            No items inside this destination.
          </Text>
        ) : null}
      </div>
    </section>
  );
}
