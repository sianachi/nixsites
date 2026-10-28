import { Icon, Text, cn, focusRing } from '@nix/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Placed } from './timeline-model';
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

export interface BarProps {
  readonly placed: Placed;
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
export function Bar({ placed, onOpen, continuesBefore, continuesAfter }: BarProps): ReactNode {
  const openProps = useTimelineOpenProps(onOpen);
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      {...openProps(placed.item.id)}
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
        'relative flex h-6 pointer-coarse:h-(--control-lg) w-full items-center gap-1 rounded-sm px-2 text-left',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        barStates,
        focusRing,
      )}
    >
      {/* Decorative: the accessible name already carries the item's true dates, which is what says
          the bar runs past the window. A pair of announced chevrons would say it twice, worse. */}
      {continuesBefore ? (
        <Icon icon={ChevronLeft} size="sm" className="shrink-0 text-accent-text" />
      ) : null}

      <Text variant="caption" as="span" className="min-w-0 flex-1 truncate">
        {titleOf(placed.item)}
      </Text>

      {continuesAfter ? (
        <Icon icon={ChevronRight} size="sm" className="shrink-0 text-accent-text" />
      ) : null}
    </button>
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
  onOpen,
}: {
  readonly placed: Placed;
  readonly onOpen: (itemId: string) => void;
}): ReactNode {
  const openProps = useTimelineOpenProps(onOpen);
  return (
    <button
      type="button"
      aria-label={announce(placed)}
      {...openProps(placed.item.id)}
      // The same hit-area extension as `Bar`, for the same 20.4px height, in the same `td p-1`
      // row space - so no two of these overlap either.
      className={cn(
        'relative flex h-6 pointer-coarse:h-(--control-lg) items-center gap-1 rounded-sm bg-transparent px-1 text-left',
        'before:absolute before:inset-x-0 before:-inset-y-1',
        'hover:bg-accent/18 active:bg-accent/25 transition-colors',
        focusRing,
      )}
    >
      {/* A diamond, so a milestone is never mistaken for a very short bar at a glance. Decorative:
          the control's name says "no end date" in words, which a shape cannot. */}
      <span aria-hidden="true" className="size-2 shrink-0 rotate-45 bg-accent-text" />
      <Text variant="caption" as="span" className="min-w-0 truncate">
        {titleOf(placed.item)}
      </Text>
    </button>
  );
}
