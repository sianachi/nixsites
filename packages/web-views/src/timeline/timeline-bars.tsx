import { Icon, Text, cn, focusRing, useFlash } from '@nix/ui';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { useRef, useState, type PointerEvent, type ReactNode } from 'react';

import type { AsideContext, Placed } from './timeline-model';
import { daysBetween, type MoveEdge } from './timeline-move';
import { titleOf } from './timeline-model';
import { announce } from './timeline-text';
import { useTimelineOpenProps } from './use-timeline-open-props';

/**
 * How a bar and a milestone answer a pointer and a press.
 *
 * `bg-accent/18` at rest is the step the calendar marks today with and this file's own column
 * heading uses, so a bar crossing the today column does not composite two different tints and
 * swallow the marker. The hover and pressed steps come from the accent ramp, which is where every
 * other interactive surface in the product takes them from.
 */
const barStates = 'bg-accent/18 hover:bg-accent/25 active:bg-accent/35 transition-colors';

const DRAG_THRESHOLD_PX = 4;

/**
 * Drag a bar (or its edges, or a milestone) across the day columns it sits in.
 *
 * The distance is measured against the real cell the bar is drawn in (its width over its column
 * span), so the snap always lands on a drawn column - a week at the quarter grain. A resize is
 * clamped so it cannot cross the other edge. Touch moves only by the grip and the edge handles
 * (`touch-none`), so the rest of the bar still scrolls the axis.
 */
function useBarDrag(placed: Placed, aside: AsideContext, columns: number) {
  const [drag, setDrag] = useState<{ edge: MoveEdge; days: number; px: number } | null>(null);
  const gesture = useRef<{ edge: MoveEdge; x: number; cell: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const length =
    placed.start === null || placed.end === null ? 0 : daysBetween(placed.start, placed.end);
  const step = aside.daysPerColumn;
  // True once after a drag, so the click that ends it does not also open the item.
  const consumeClick = (): boolean => {
    const was = suppressClick.current;
    suppressClick.current = false;
    return was;
  };

  function snap(clientX: number, edge: MoveEdge, held?: typeof gesture.current): number {
    const g = held ?? gesture.current;
    if (g === null) {
      return 0;
    }
    const days = Math.round((clientX - g.x) / g.cell) * step;
    if (edge === 'start') {
      return Math.min(days, length);
    }
    return edge === 'end' ? Math.max(days, -length) : days;
  }

  const handlers = (edge: MoveEdge, touchToo: boolean) => ({
    onPointerDown(e: PointerEvent<HTMLElement>) {
      if (e.button !== 0 || (e.pointerType === 'touch' && !touchToo) || placed.start === null) {
        return;
      }
      const cellEl = e.currentTarget.closest('td');
      if (cellEl === null) {
        return;
      }
      e.currentTarget.setPointerCapture(e.pointerId);
      e.stopPropagation();
      gesture.current = { edge, x: e.clientX, cell: cellEl.offsetWidth / columns, moved: false };
    },
    onPointerMove(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      if (g === null) {
        return;
      }
      g.moved ||= Math.abs(e.clientX - g.x) > DRAG_THRESHOLD_PX;
      if (g.moved) {
        const days = snap(e.clientX, edge);
        setDrag({ edge, days, px: (days / step) * g.cell });
      }
    },
    onPointerUp(e: PointerEvent<HTMLElement>) {
      const g = gesture.current;
      gesture.current = null;
      setDrag(null);
      if (g?.moved === true) {
        suppressClick.current = true;
        aside.move(placed, edge, snap(e.clientX, edge, g));
      }
    },
    onPointerCancel() {
      gesture.current = null;
      setDrag(null);
    },
  });

  const px = drag?.px ?? 0;
  const style =
    drag === null
      ? undefined
      : drag.edge === 'both'
        ? { transform: `translateX(${String(px)}px)` }
        : drag.edge === 'start'
          ? { marginLeft: px, width: `calc(100% - ${String(px)}px)` }
          : { width: `calc(100% + ${String(px)}px)` };

  return { handlers, style, dragging: drag !== null, consumeClick };
}

const grip =
  'touch-none cursor-grab text-muted opacity-0 group-hover/bar:opacity-100 group-focus-within/bar:opacity-100 pointer-coarse:opacity-100';

export interface BarProps {
  readonly placed: Placed;
  readonly aside: AsideContext;
  readonly onOpen: (itemId: string) => void;
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
}

/**
 * A span, drawn across the columns it covers.
 *
 * **The accessible name carries the dates the item really has, never the clipped ones.** A bar cut
 * off at the edge of the window is announced with its true start and its true end, because the cut
 * is a fact about the window and not about the item - and somebody told the truncated date would
 * have no way of knowing they had been.
 */
export function Bar({
  placed,
  aside,
  onOpen,
  continuesBefore,
  continuesAfter,
}: BarProps): ReactNode {
  const openProps = useTimelineOpenProps(onOpen);
  const flash = useFlash(placed.item.updatedAt);
  const p = placed.placement;
  const drag = useBarDrag(placed, aside, p.kind === 'span' ? p.last - p.first + 1 : 1);
  const open = openProps(placed.item.id);
  const body = drag.handlers('both', false);
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      {...flash}
      {...open}
      {...body}
      style={drag.style}
      onClick={(e) => {
        if (drag.consumeClick()) {
          return;
        }
        open.onClick(e);
      }}
      // A tint rather than a solid accent fill. The design grammar reserves the solid accent for
      // the primary button - one of them per screen - and a row of forty saturated bars would
      // drown it.
      // `relative before:*`: h-6 is 20.4px at this density, under WCAG 2.5.8's 24px floor, and a
      // taller bar would push the rows apart. The pseudo-element extends the hit area one spacing
      // step past each edge without moving a pixel of what is drawn - the pane-divider technique.
      //
      // The extension is the row's own space, not the next row's, which is what stops one bar
      // stealing the bottom of another's target: each bar sits in a `td` with `p-1`, so between
      // two bars in successive rows there is 3.4px + a 1px border + 3.4px. Two 3.4px extensions
      // meet in the middle of that and never overlap. A row that ever loses its cell padding has
      // to shrink this to `-inset-y-0.5` in the same edit.
      className={cn(
        'group/bar relative flex h-6 pointer-coarse:h-(--control-lg) w-full items-center gap-1 rounded-sm px-2 text-left select-none',
        'cursor-grab',
        drag.dragging && 'z-20 cursor-grabbing shadow-md',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        barStates,
        focusRing,
      )}
    >
      {/* Decorative: the accessible name already carries the item's true dates, which is what says
          the bar runs past the window. A pair of announced chevrons would say it twice, worse. */}
      <MoveGrip drag={drag} />

      {continuesBefore ? (
        <Icon icon={ChevronLeft} size="sm" className="shrink-0 text-accent-text" />
      ) : (
        <EdgeHandle side="start" drag={drag} />
      )}

      <Text variant="caption" as="span" className="min-w-0 flex-1 truncate">
        {titleOf(placed.item)}
      </Text>

      {continuesAfter ? (
        <Icon icon={ChevronRight} size="sm" className="shrink-0 text-accent-text" />
      ) : (
        <EdgeHandle side="end" drag={drag} />
      )}
    </button>
  );
}

type Drag = ReturnType<typeof useBarDrag>;

/** The grip: always drags, with touch too. Decorative to assistive tech; the panel buttons are the accessible path. */
function MoveGrip({ drag }: { readonly drag: Drag }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(grip, 'flex shrink-0 items-center pointer-coarse:p-2')}
      {...drag.handlers('both', true)}
    >
      <Icon icon={GripVertical} size="sm" />
    </span>
  );
}

function EdgeHandle({
  side,
  drag,
}: {
  readonly side: 'start' | 'end';
  readonly drag: Drag;
}): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cn(
        grip,
        'absolute inset-y-0 w-2 cursor-ew-resize pointer-coarse:w-4 hover:bg-accent/35 active:bg-accent/50 rounded-sm',
        side === 'start' ? 'left-0' : 'right-0',
      )}
      {...drag.handlers(side, true)}
    />
  );
}

/**
 * A start with no end.
 *
 * A marker on the day, not a bar of any width. A zero-width bar would be invisible and a bar drawn
 * to today would be an end date this application made up - and one that moved every morning.
 */
export function Milestone({
  placed,
  aside,
  onOpen,
}: {
  readonly placed: Placed;
  readonly aside: AsideContext;
  readonly onOpen: (itemId: string) => void;
}): ReactNode {
  const openProps = useTimelineOpenProps(onOpen);
  const flash = useFlash(placed.item.updatedAt);
  const drag = useBarDrag(placed, aside, 1);
  const open = openProps(placed.item.id);
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      {...flash}
      {...open}
      {...drag.handlers('both', false)}
      style={drag.style}
      onClick={(e) => {
        if (drag.consumeClick()) {
          return;
        }
        open.onClick(e);
      }}
      // The same hit-area extension as `Bar`, for the same 20.4px height, in the same `td p-1`
      // row space - so no two of these overlap either.
      className={cn(
        'group/bar relative flex h-6 pointer-coarse:h-(--control-lg) cursor-grab select-none items-center gap-1 rounded-sm bg-transparent px-1 text-left',
        drag.dragging && 'z-20 cursor-grabbing bg-accent/25',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        'hover:bg-accent/18 active:bg-accent/25 transition-colors',
        focusRing,
      )}
    >
      {/* A diamond, so a milestone is never mistaken for a very short bar at a glance. Decorative:
          the control's name says "no end date" in words, which a shape cannot. */}
      <MoveGrip drag={drag} />
      <span aria-hidden="true" className="size-2 shrink-0 rotate-45 bg-accent-text" />
      <Text variant="caption" as="span" className="min-w-0 truncate">
        {titleOf(placed.item)}
      </Text>
    </button>
  );
}
