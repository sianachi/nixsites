import { Button, Dialog, Icon, Text, focusRing } from '@nix/ui';
import { ArrowUp, Folder } from 'lucide-react';
import { useState, type ReactNode } from 'react';

interface DriveMoveDestination {
  readonly id: string;
  readonly title: string;
}

export interface DriveMoveDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;

  /** How many items are about to move, for the confirm button's label. */
  readonly selectedCount: number;

  /** This container's own sub-containers: children that can hold the selection. */
  readonly destinations: readonly DriveMoveDestination[];

  /**
   * The container this drive is drawing, one level up - offered as "Parent" - or `undefined` when
   * that is not known yet (still being resolved) or there is nowhere further up to offer.
   */
  readonly parent: { readonly id: string | null } | undefined;

  /** Moves the selection to the chosen destination and closes the dialog. */
  readonly onMove: (targetParentId: string | null) => void;
}

/**
 * "Move to…" - where the selection bar's bulk move lands.
 *
 * The destinations are exactly the sub-containers of the drive already on screen, plus this
 * container's own parent under the word "Parent": nothing here asks for a picker over the whole
 * workspace, because a drive is a view of one container and the only moves it needs to offer are
 * the ones that keep the gesture inside what is already visible.
 */
export function DriveMoveDialog(props: DriveMoveDialogProps): ReactNode {
  const { open, onClose, selectedCount, destinations, parent, onMove } = props;
  const [target, setTarget] = useState<string | null | undefined>(undefined);

  const confirm = (): void => {
    if (target === undefined) return;
    onMove(target);
  };

  return (
    <Dialog
      open={open}
      title="Move to…"
      onClose={onClose}
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={confirm} disabled={target === undefined}>
            {`Move ${String(selectedCount)} ${selectedCount === 1 ? 'item' : 'items'}`}
          </Button>
        </>
      }
    >
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="sr-only">Choose a destination</legend>

        {parent !== undefined ? (
          <DestinationOption
            id="drive-move-parent"
            icon={ArrowUp}
            label="Parent"
            checked={target === parent.id}
            onSelect={() => {
              setTarget(parent.id);
            }}
          />
        ) : null}

        {destinations.length === 0 && parent === undefined ? (
          <Text variant="body" tone="muted">
            There is nowhere else in this drive to move to.
          </Text>
        ) : null}

        {destinations.map((destination) => (
          <DestinationOption
            key={destination.id}
            id={`drive-move-${destination.id}`}
            icon={Folder}
            label={destination.title || 'Untitled'}
            checked={target === destination.id}
            onSelect={() => {
              setTarget(destination.id);
            }}
          />
        ))}
      </fieldset>
    </Dialog>
  );
}

function DestinationOption({
  id,
  icon,
  label,
  checked,
  onSelect,
}: {
  readonly id: string;
  readonly icon: typeof Folder;
  readonly label: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  return (
    <label htmlFor={id} className="flex min-w-0 items-center gap-2 rounded p-2 hover:bg-accent/10">
      <input
        id={id}
        type="radio"
        name="drive-move-target"
        checked={checked}
        onChange={onSelect}
        className={`${focusRing} shrink-0`}
      />
      <Icon icon={icon} size="sm" />
      <Text variant="body" as="span" className="min-w-0 flex-1">
        {label}
      </Text>
    </label>
  );
}
