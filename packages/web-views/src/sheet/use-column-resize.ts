import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { type ResizeDrag, beginColumnResize, moveColumnResize } from './column-resize';
import type { SheetData } from './use-sheet';

/**
 * The column-resize drag: its state, the one-frame pointermove coalescing, and the handlers
 * for the capture overlay that owns move, release and cancel.
 */
export interface ColumnResize {
  resize: ResizeDrag | null;
  cancelResize: () => void;
  onHandlePointerDown: (
    col: number,
    width: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => void;
  onOverlayPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOverlayPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onOverlayPointerCancel: () => void;
}

export function useColumnResize(sheet: SheetData): ColumnResize {
  const [resize, setResize] = useState<ResizeDrag | null>(null);
  // The latest pointer position and the one frame scheduled to apply it:
  // pointermove fires at the pointer's report rate (well past 60Hz on gaming
  // mice), each event its own task, so moves coalesce to one state write per
  // animation frame.
  const dragXRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);

  function stopDragFrame(): void {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    dragXRef.current = null;
  }

  // A frame scheduled by the last pointermove of a drag must not fire into an
  // unmounted grid.
  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
    };
  }, []);

  function cancelResize(): void {
    stopDragFrame();
    setResize(null);
  }

  function onHandlePointerDown(
    col: number,
    width: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ): void {
    // preventDefault stops the header text from being selected by the drag;
    // focus is taken explicitly instead, so the ring and the keys (Escape to
    // cancel, arrows to fine-tune) are there if the person switches
    // mid-thought.
    event.preventDefault();
    event.currentTarget.focus();
    setResize(
      beginColumnResize({
        col,
        pointerId: event.pointerId,
        clientX: event.clientX,
        width: width,
      }),
    );
  }

  // Move, release and cancel live on the capture overlay, not the handle: the
  // handle is virtualized, so a drag that scrolls its column out of the
  // render window would unmount it mid-gesture and strand the drag with the
  // overlay swallowing every pointer event. The overlay exists exactly while
  // a drag is live and nothing can unmount it but the drag ending.
  function onOverlayPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resize?.pointerId !== event.pointerId) {
      return;
    }
    // A mouse released outside the window sends its pointerup where the
    // overlay cannot hear it, and the next move arrives with no button held.
    // Without this, the phantom drag keeps resizing and the next click
    // commits it; cancelling is the honest reading of a button nobody is
    // pressing. Touch and pen never hit it - they get implicit capture.
    if (event.buttons === 0) {
      stopDragFrame();
      setResize(null);
      return;
    }
    dragXRef.current = event.clientX;
    dragFrameRef.current ??= requestAnimationFrame(() => {
      dragFrameRef.current = null;
      const clientX = dragXRef.current;
      if (clientX !== null) {
        setResize((drag) => (drag === null ? null : moveColumnResize(drag, clientX)));
      }
    });
  }

  function onOverlayPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resize?.pointerId !== event.pointerId) {
      return;
    }
    stopDragFrame();
    // One write on release, not one per move: the drag previews locally and
    // the shared document receives a single undoable width change. The
    // release position is authoritative - it may be newer than the last
    // frame the preview painted.
    sheet.setColumnWidth(resize.col, moveColumnResize(resize, event.clientX).width);
    setResize(null);
  }

  function onOverlayPointerCancel(): void {
    // A cancelled gesture (browser took the pointer, touch was interrupted)
    // reverts rather than committing whatever width it happened to reach.
    stopDragFrame();
    setResize(null);
  }

  return {
    resize,
    cancelResize,
    onHandlePointerDown,
    onOverlayPointerMove,
    onOverlayPointerUp,
    onOverlayPointerCancel,
  };
}
