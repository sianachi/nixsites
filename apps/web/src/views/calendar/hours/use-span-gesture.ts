import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { CalendarDay } from '../../../collections/core/calendar-dates';
import type { Item } from '../../../collections/core/container-model';
import { readTimestampValue } from '../../../collections/core/timestamps';
import { movedStart, resizedDuration } from '../span-gesture';
import { DRAG_THRESHOLD_PX, ROW_HEIGHT, type Placed, type SpanGesture } from './geometry';
import { momentAt, writeMoment } from './placement';

interface Options {
  readonly days: readonly CalendarDay[];
  readonly zone: string;
  readonly dateProperty: string;
  readonly endDateProperty: string | null;
  readonly onMove?: ((itemId: string, values: Record<string, string | null>) => void) | undefined;
  readonly adjustable: (item: Item) => boolean;
}

/** The pointer drag and foot-stretch of a placed item, with the preview and click guard it owes. */
export function useSpanGesture(options: Options): {
  readonly gesture: SpanGesture | null;
  readonly beginGesture: (
    event: ReactPointerEvent<HTMLElement>,
    entry: Placed,
    dayIndex: number,
    kind: 'move' | 'resize',
  ) => void;
  readonly suppressClick: { current: boolean };
} {
  const { days, zone, dateProperty, endDateProperty, onMove, adjustable } = options;

  // The drag in progress, if any. State for the preview the columns draw; the ref is what the
  // window listeners read, since they outlive the render that attached them.
  const [gesture, setGesture] = useState<SpanGesture | null>(null);
  const gestureRef = useRef<SpanGesture | null>(null);
  const endGesture = useRef<(() => void) | null>(null);

  // A drag that ends over the card it began on is followed by a click on that card. This is how
  // the card knows not to open the item it was just moved by.
  const suppressClick = useRef(false);

  useEffect(
    () => () => {
      endGesture.current?.();
    },
    [],
  );

  function commitGesture(final: SpanGesture, entry: Placed, fromDayIndex: number): void {
    const day = days[final.dayIndex];
    if (onMove === undefined || day === undefined) {
      return;
    }

    const values: Record<string, string | null> = {};
    if (final.kind === 'move') {
      if (final.dayIndex === fromDayIndex && final.minutes === entry.minutes) {
        return;
      }
      const start = momentAt(day, final.minutes, zone);
      values[dateProperty] = writeMoment(start, zone);

      // The end travels with the start, so a move keeps the item as long as it was. A drop used
      // to write the start alone, which silently stretched or reversed the span.
      const before = readTimestampValue(entry.item.properties, dateProperty);
      const end =
        endDateProperty === null
          ? null
          : readTimestampValue(entry.item.properties, endDateProperty);
      if (endDateProperty !== null && before !== null && end !== null) {
        values[endDateProperty] = writeMoment(end.at.plus(start.diff(before.at)), zone);
      }
    } else {
      if (endDateProperty === null || final.durationMinutes === null) {
        return;
      }
      if (final.durationMinutes === entry.durationMinutes) {
        return;
      }
      values[endDateProperty] = writeMoment(
        momentAt(day, entry.minutes + final.durationMinutes, zone),
        zone,
      );
    }

    onMove(entry.item.id, values);
  }

  function beginGesture(
    event: ReactPointerEvent<HTMLElement>,
    entry: Placed,
    dayIndex: number,
    kind: 'move' | 'resize',
  ): void {
    if (onMove === undefined || event.button !== 0 || !adjustable(entry.item)) {
      return;
    }

    // Moving is a mouse only. A finger or a pen on a card is scrolling the day, and the browser
    // takes the gesture for that the moment it moves. Stretching is different: on a coarse pointer
    // the foot is a small grip of its own with `touch-action: none`, so a press there is
    // unmistakably a press on the grip and the browser leaves it alone - a swipe across the card
    // still scrolls, because the grip is only as wide as itself.
    if (event.pointerType !== 'mouse' && kind !== 'resize') {
      return;
    }

    const root = event.currentTarget.closest('[data-hour-grid]');
    if (root === null) {
      return;
    }
    const columns = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>('[data-day-column]'));
    const minutesAt = (column: HTMLElement, clientY: number): number =>
      ((clientY - column.getBoundingClientRect().top) / ROW_HEIGHT) * 60;

    const origin = columns()[dayIndex];
    if (origin === undefined) {
      return;
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const grabOffset = minutesAt(origin, event.clientY) - entry.minutes;

    // A resize begins at once: its handle does nothing else. A move waits for the pointer to
    // travel, so a plain click still opens the item.
    let active = kind === 'resize';
    if (kind === 'resize') {
      event.preventDefault();
      event.stopPropagation();
    }

    const onPointerMove = (moved: PointerEvent): void => {
      if (moved.pointerId !== pointerId) {
        return;
      }
      if (!active) {
        if (Math.hypot(moved.clientX - startX, moved.clientY - startY) < DRAG_THRESHOLD_PX) {
          return;
        }
        active = true;
      }
      moved.preventDefault();

      const all = columns();
      // The column under the pointer, or the one the drag is already in when the pointer has
      // wandered off the grid sideways. Read live, so the grid scrolling mid-drag stays correct.
      const over =
        kind === 'move'
          ? all.findIndex((column) => {
              const box = column.getBoundingClientRect();
              return moved.clientX >= box.left && moved.clientX < box.right;
            })
          : dayIndex;
      const target = over === -1 ? (gestureRef.current?.dayIndex ?? dayIndex) : over;
      const column = all[target];
      if (column === undefined) {
        return;
      }

      const at = minutesAt(column, moved.clientY);
      const next: SpanGesture =
        kind === 'move'
          ? {
              itemId: entry.item.id,
              kind,
              dayIndex: target,
              minutes: movedStart(at, grabOffset),
              durationMinutes: entry.durationMinutes,
            }
          : {
              itemId: entry.item.id,
              kind,
              dayIndex,
              minutes: entry.minutes,
              durationMinutes: resizedDuration(entry.minutes, at),
            };
      gestureRef.current = next;
      setGesture(next);
    };

    const finish = (commit: boolean): void => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      window.removeEventListener('keydown', onKeyDownWhileDragging, true);
      endGesture.current = null;

      const final = gestureRef.current;
      gestureRef.current = null;
      setGesture(null);
      if (final === null) {
        return;
      }

      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (commit) {
        commitGesture(final, entry, dayIndex);
      }
    };
    const onPointerUp = (released: PointerEvent): void => {
      if (released.pointerId === pointerId) {
        finish(true);
      }
    };
    const onPointerCancel = (cancelled: PointerEvent): void => {
      if (cancelled.pointerId === pointerId) {
        finish(false);
      }
    };
    // Escape puts the item back, the same way out every other drag in the application has.
    const onKeyDownWhileDragging = (pressed: KeyboardEvent): void => {
      if (pressed.key === 'Escape') {
        // Kept to the drag: the same key closes a pane, and one press should not do both.
        pressed.preventDefault();
        pressed.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    window.addEventListener('keydown', onKeyDownWhileDragging, true);
    endGesture.current = () => {
      finish(false);
    };
  }

  return { gesture, beginGesture, suppressClick };
}
