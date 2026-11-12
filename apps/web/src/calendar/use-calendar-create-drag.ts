import { useRef, type DOMAttributes, type PointerEvent } from 'react';
import { addDays, dayFromText, dayText } from '@nix/web-collections/core/calendar-dates';

export interface CalendarPick {
  readonly day: string;
  readonly time?: string;
  readonly end?: string;
}

const SLOT = '[data-calendar-pick]';

function nextHour(slot: string): string {
  const hour = Number(slot.slice(11, 13));
  if (hour < 23) return `${slot.slice(0, 11)}${String(hour + 1).padStart(2, '0')}:00`;
  const day = dayFromText(slot.slice(0, 10));
  return day === null ? slot : `${dayText(addDays(day, 1))}T00:00`;
}

export function useCalendarCreateDrag(
  enabled: boolean,
  onPick: (pick: CalendarPick) => void,
): Pick<
  DOMAttributes<HTMLDivElement>,
  'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
> {
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    start: string;
    end: string | null;
  } | null>(null);

  function clear(container: HTMLElement): void {
    for (const cell of container.querySelectorAll('[data-calendar-selection]')) {
      cell.removeAttribute('data-calendar-selection');
    }
  }

  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>): void {
      if (
        !enabled ||
        event.button !== 0 ||
        event.pointerType !== 'mouse' ||
        !(event.target instanceof Element)
      )
        return;
      if (event.target.closest('button, a, input, textarea, select, [role="button"]')) return;
      const slot = event.target.closest<HTMLElement>(SLOT)?.dataset.calendarPick;
      if (slot === undefined) return;
      event.preventDefault();
      if (typeof event.currentTarget.setPointerCapture === 'function')
        event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        start: slot,
        end: null,
      };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>): void {
      const active = drag.current;
      if (
        active?.id !== event.pointerId ||
        (active.end === null && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5)
      )
        return;
      const container = event.currentTarget;
      const cell = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>(SLOT);
      if (cell === undefined || cell === null || !container.contains(cell)) return;
      const slot = cell.dataset.calendarPick;
      if (slot?.length !== active.start.length || slot === active.end) return;
      active.end = slot;
      const [first, last] = active.start < slot ? [active.start, slot] : [slot, active.start];
      for (const target of container.querySelectorAll<HTMLElement>(SLOT)) {
        const value = target.dataset.calendarPick;
        target.toggleAttribute(
          'data-calendar-selection',
          value?.length === first.length && value >= first && value <= last,
        );
      }
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>): void {
      const active = drag.current;
      if (active?.id !== event.pointerId) return;
      drag.current = null;
      clear(event.currentTarget);
      if (active.end === null) return;
      const [start, end] =
        active.start < active.end ? [active.start, active.end] : [active.end, active.start];
      const timed = start.includes('T');
      onPick({
        day: start.slice(0, 10),
        ...(timed ? { time: start.slice(11) } : {}),
        ...(start === end ? {} : { end: timed ? nextHour(end) : end }),
      });
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>): void {
      drag.current = null;
      clear(event.currentTarget);
    },
  };
}
