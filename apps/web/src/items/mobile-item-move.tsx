import { Button, Dialog, Icon, Text } from '@nix/ui';
import { ArrowDown, ArrowLeft, ArrowUp } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { MobileDestinationPicker } from '@nix/web-collections/items/mobile-destination-picker';
import { WorkspaceItemTransfer } from './workspace-item-transfer';
import { useOptionalWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { siblingMoveTarget } from './sibling-move-target';
import type { TreeItem, WorkspaceTree } from '@nix/web-collections/items/use-workspace-tree';

type Step = 'destination' | 'position' | 'workspace';

/**
 * A slot between siblings (or before the first, or after the last) that a tap can place the item
 * into. Every slot needs its own accessible name - "Place here" repeated across a list is
 * indistinguishable to a screen reader, so each one names what it sits after.
 */
function PlaceHereSlot({
  label,
  selected,
  disabled,
  onSelect,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <Button
      variant={selected ? 'primary' : 'ghost'}
      aria-pressed={selected}
      disabled={disabled}
      className="min-w-0 w-full justify-start"
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  );
}

export function MobileItemMove({
  itemId,
  tree,
  onClose,
}: {
  readonly itemId: string;
  readonly tree: WorkspaceTree;
  readonly onClose: () => void;
}): ReactNode {
  const workspace = useOptionalWorkspace();
  const current = tree.find(itemId);
  const currentParentId = current?.parentId ?? null;

  const [step, setStep] = useState<Step>('destination');
  const [parentId, setParentId] = useState<string | null>(currentParentId);
  const [afterId, setAfterId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  async function runMove(
    targetParentId: string | null,
    targetAfterId: string | null,
  ): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await tree.move(itemId, targetParentId, targetAfterId);
      if (result.refusal !== null) setError(result.refusal);
      else onClose();
    } catch {
      setError('The move could not be confirmed. Check the workspace before retrying.');
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  // The item's real siblings, for the quick up/down actions and for knowing where it already sits
  // - independent of whatever destination is being browsed in the picker below.
  const siblings = tree.childrenOf(currentParentId);
  const index = siblings.findIndex((sibling) => sibling.id === itemId);
  const canMoveUp = index > 0;
  const canMoveDown = index >= 0 && index < siblings.length - 1;
  const currentAfterId = index > 0 ? (siblings[index - 1]?.id ?? null) : null;

  function moveUp(): void {
    // Before the sibling above, which is after the one above that - the same landing the desktop
    // tree's Alt+ArrowUp produces.
    void runMove(currentParentId, siblingMoveTarget(siblings, index, 'up'));
  }

  function moveDown(): void {
    void runMove(currentParentId, siblingMoveTarget(siblings, index, 'down'));
  }

  // A destination that is the item's own current parent isn't a new place to browse for a slot -
  // it's the item's own list, so the position step should open on where the item already sits
  // rather than silently defaulting to the top.
  function initialAfterIdFor(destinationParentId: string | null): string | null {
    return destinationParentId === currentParentId ? currentAfterId : null;
  }

  const destinationChildren = tree
    .childrenOf(parentId)
    .filter((item: TreeItem) => item.id !== itemId);
  const destinationLoading =
    tree.status === 'loading' || (parentId !== null && tree.isLoadingChildren(parentId));
  const destination = parentId === null ? null : tree.find(parentId);
  const noChange = parentId === currentParentId && afterId === currentAfterId;

  return (
    <Dialog
      open
      title={
        step === 'workspace'
          ? 'Move item: another workspace'
          : step === 'destination'
            ? 'Move item: choose a place'
            : 'Move item: choose a position'
      }
      swipeToClose={!saving}
      onClose={() => {
        if (!pending.current && !saving) onClose();
      }}
      actions={
        step === 'workspace' ? (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setStep('destination');
            }}
          >
            Back
          </Button>
        ) : step === 'destination' ? (
          <Button
            disabled={saving}
            onClick={() => {
              setAfterId(initialAfterIdFor(parentId));
              setStep('position');
            }}
          >
            Choose position
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setStep('destination');
              }}
            >
              <Icon icon={ArrowLeft} size="sm" /> Back
            </Button>
            <Button
              disabled={saving || noChange}
              onClick={() => {
                void runMove(parentId, afterId);
              }}
            >
              {saving ? 'Moving…' : 'Move here'}
            </Button>
          </>
        )
      }
    >
      {step !== 'workspace' ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={saving || !canMoveUp} onClick={moveUp}>
            <Icon icon={ArrowUp} size="sm" /> Move up
          </Button>
          <Button variant="secondary" disabled={saving || !canMoveDown} onClick={moveDown}>
            <Icon icon={ArrowDown} size="sm" /> Move down
          </Button>
        </div>
      ) : null}

      {step === 'workspace' && workspace !== null ? (
        <WorkspaceItemTransfer
          itemId={itemId}
          sourceWorkspaceId={workspace.workspaceId}
          onClose={onClose}
          onBusyChange={setSaving}
        />
      ) : step === 'destination' ? (
        <>
          {workspace !== null ? (
            <Button
              variant="secondary"
              disabled={saving}
              onClick={() => {
                setStep('workspace');
              }}
            >
              Move to another workspace
            </Button>
          ) : null}
          <MobileDestinationPicker
            tree={tree}
            parentId={parentId}
            onChange={(id) => {
              setParentId(id);
              setAfterId(initialAfterIdFor(id));
            }}
            disabled={saving}
            purpose="move"
            excludedId={itemId}
          />
        </>
      ) : (
        <section aria-label="Position" className="flex min-h-0 min-w-0 flex-col gap-2">
          <Text as="p" variant="bodySmall">
            Place in: {parentId === null ? 'Workspace' : (destination?.title ?? '') || 'Untitled'}
          </Text>
          {destinationLoading ? (
            <Text variant="note" role="status">
              Loading placement…
            </Text>
          ) : null}
          <div className="max-h-60 overflow-y-auto overscroll-contain rounded-md border border-divider">
            <PlaceHereSlot
              label="Place at the top"
              selected={afterId === null}
              disabled={saving}
              onSelect={() => {
                setAfterId(null);
              }}
            />
            {destinationChildren.map((child) => (
              <div key={child.id}>
                <div className="px-3 py-2">
                  <Text as="span" variant="bodySmall" className="block min-w-0 truncate">
                    {child.title || 'Untitled'}
                  </Text>
                </div>
                <PlaceHereSlot
                  label={`Place after ${child.title || 'Untitled'}`}
                  selected={afterId === child.id}
                  disabled={saving}
                  onSelect={() => {
                    setAfterId(child.id);
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {error ? (
        <Text variant="note" role="alert">
          {error}
        </Text>
      ) : null}
    </Dialog>
  );
}
