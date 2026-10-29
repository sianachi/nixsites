import { useState, type DragEvent, type HTMLAttributes } from 'react';

type DropZone = Pick<HTMLAttributes<HTMLElement>, 'onDragLeave' | 'onDragOver' | 'onDrop'>;

/**
 * The address a drop gesture carries, if it carries one.
 *
 * `text/uri-list` first, because it is the type an image or a link is dragged as and its grammar
 * is defined (one URI per line, `#` lines are comments); `text/plain` as the fallback for text
 * selections and address-bar drags that never set the richer type.
 */
function droppedAddress(transfer: DataTransfer): string {
  const line = transfer
    .getData('text/uri-list')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith('#'));

  return line ?? transfer.getData('text/plain').trim();
}

/**
 * One drop target per state, wired identically: the address box while it is empty or being
 * edited, the whole set row otherwise, so dropping onto a picture replaces it.
 *
 * A dropped address or file is handed on; what to do with it stays with the control.
 */
export function useImageDrop({
  disabled,
  onAddress,
  onFile,
}: {
  readonly disabled: boolean;
  readonly onAddress: (address: string) => void;
  readonly onFile: (file: File) => void;
}): { readonly dropZone: DropZone; readonly droppingFrame: string } {
  const [dropping, setDropping] = useState(false);

  const dropZone = disabled
    ? {}
    : {
        onDragOver: (event: DragEvent<HTMLElement>) => {
          // Preventing the default is what marks this element as a drop target at all; without it
          // the browser refuses the drop and the gesture silently does nothing.
          event.preventDefault();
          setDropping(true);
        },
        onDragLeave: () => {
          setDropping(false);
        },
        onDrop: (event: DragEvent<HTMLElement>) => {
          event.preventDefault();
          setDropping(false);

          const address = droppedAddress(event.dataTransfer);
          if (address.length > 0) {
            onAddress(address);
            return;
          }

          // A file drag carries neither `text/uri-list` nor `text/plain`, so there is no address
          // to read.
          const file = event.dataTransfer.files[0];
          if (file !== undefined) onFile(file);
        },
      };

  // The same visual answer the board's columns and the sidebar's rows give a hovering drag.
  const droppingFrame = dropping ? 'outline-2 -outline-offset-2 outline-accent' : '';

  return { dropZone, droppingFrame };
}
