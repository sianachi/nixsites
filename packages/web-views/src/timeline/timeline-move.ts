import { addDays, dayFromText, dayText } from '@nix/web-collections/core/calendar-dates';
import { useUndo } from '@nix/ui';
import { useCallback, useState } from 'react';

import { place, titleOf, describeWhere, type AsideContext, type Placed } from './timeline-model';
import { spoken } from './timeline-text';
import type { TimelineWindow } from './timeline-scale';

/** Which dates a change moves: both (the whole bar), or one edge. */
export type MoveEdge = 'both' | 'start' | 'end';

/** `yyyy-MM-dd` text shifted by whole days, or null when it is not a plain date. */
export function shiftDay(date: string, days: number): string | null {
  const day = dayFromText(date);
  return day === null ? null : dayText(addDays(day, days));
}

/** Whole days from `a` to `b`, both `yyyy-MM-dd`. UTC arithmetic on integers, never on a stored string. */
export function daysBetween(a: string, b: string): number {
  const from = dayFromText(a);
  const to = dayFromText(b);
  if (from === null || to === null) {
    return 0;
  }
  return Math.round(
    (Date.UTC(to.year, to.month, to.day) - Date.UTC(from.year, from.month, from.day)) / 86_400_000,
  );
}

function plural(days: number): string {
  const n = Math.abs(days);
  return `${String(n)} ${n === 1 ? 'day' : 'days'} ${days < 0 ? 'earlier' : 'later'}`;
}

/**
 * The one way dates change on this screen: buttons, drag and resize all come here.
 * Only plain `date` values move; a timestamp would lose its time of day, so those items offer no
 * move (shortcut: timestamp-backed timelines edit through the date fields, upgrade by shifting the
 * stored instant and keeping its time).
 */
export function useMoveDates(
  axis: TimelineWindow,
  zone: string,
  base: Pick<AsideContext, 'startKey' | 'endKey' | 'setProperties'>,
): { readonly move: AsideContext['move']; readonly status: string } {
  const undo = useUndo();
  const [status, setStatus] = useState('');
  const { startKey, endKey, setProperties } = base;

  const move = useCallback(
    (placed: Placed, edge: MoveEdge, days: number): void => {
      if (days === 0 || placed.start === null) {
        return;
      }
      const { item } = placed;
      const title = titleOf(item);
      const changes: Record<string, string> = {};
      const previous: Record<string, string> = {};
      const touch = (key: string, from: string | null, raw: string): void => {
        const next = from === null ? null : shiftDay(from, days);
        if (next !== null) {
          changes[key] = next;
          previous[key] = raw;
        }
      };
      if (edge !== 'end') {
        touch(startKey, placed.start, placed.startRaw);
      }
      if (edge !== 'start' && endKey !== null) {
        touch(endKey, placed.end, placed.endRaw);
      }
      if (Object.keys(changes).length === 0) {
        return;
      }

      const next = place(
        { ...item, properties: { ...item.properties, ...changes } },
        startKey,
        endKey,
        zone,
        axis,
      );
      const what = edge === 'both' ? '' : edge === 'start' ? 'start of ' : 'end of ';
      const to = `${spoken(next.start ?? '')}${next.end === null ? '' : ` to ${spoken(next.end)}`}`;
      const where = ['span', 'milestone'].includes(next.placement.kind)
        ? ''
        : ` ${describeWhere(next, axis)}`;
      const said = `Moved ${what}"${title}" ${plural(days)}: ${to}.${where}`;

      void setProperties(item.id, changes).then((refusal) => {
        if (refusal !== null) {
          setStatus(`Could not move "${title}": ${refusal}`);
          return;
        }
        setStatus(said);
        undo.push(`Moved ${what}${title} ${plural(days)}`, async () => {
          const again = await setProperties(item.id, previous);
          setStatus(
            again === null
              ? `Put "${title}" back: ${plural(-days)}.`
              : `Could not undo the move of "${title}": ${again}`,
          );
        });
      });
    },
    [axis, endKey, setProperties, startKey, undo, zone],
  );

  return { move, status };
}
