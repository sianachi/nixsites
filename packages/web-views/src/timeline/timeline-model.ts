import {
  readPropertyText,
  type ContainerViews,
  type EffectiveSchema,
  type Item,
  type View,
} from '@nix/web-collections/core/container-model';
import { propertyTypeWord, isDateShaped } from '@nix/web-collections/core/property-types';
import { readDayValue } from '@nix/web-collections/core/day-math';
import { placeSpan, type TimelinePlacement, type TimelineWindow } from './timeline-scale';

export const NO_START_PROPERTY =
  'A timeline places each bar by the date it starts on, and this view does not name a start ' +
  'property. Nothing has been lost - every item is still here, and a list or board view will ' +
  'show them.';

export function titleOf(item: Item): string {
  return item.title || 'Untitled';
}

export function byId(itemId: string): (entry: Placed) => boolean {
  return (entry) => entry.item.id === itemId;
}

/** One item, where it sits, and the dates it really has. */
export interface Placed {
  readonly item: Item;

  /**
   * The start as the reader's day - a `date` unchanged, a `timestamp` converted.
   *
   * Deliberately not "as stored": a 09:00 London start is the previous evening in Honolulu, and the
   * day this view announces has to be the reader's or the bar and its sentence would disagree.
   */
  readonly start: string | null;

  readonly end: string | null;

  /** What the start property holds, verbatim, for the case where it is not a date at all. */
  readonly startRaw: string;

  /** The same for the end property. Empty when the view names none. */
  readonly endRaw: string;

  /**
   * The start holds something, and it is not a date.
   *
   * Its own flag rather than a shade of `undated`, because the two need opposite sentences: one
   * item is waiting to be scheduled and the other has a value nobody can read.
   */
  readonly unreadable: boolean;

  readonly placement: TimelinePlacement;
}

export function place(
  item: Item,
  startKey: string,
  endKey: string | null,
  zone: string,
  axis: TimelineWindow,
): Placed {
  const start = readDayValue(item, startKey, zone);
  const end = endKey === null ? null : readDayValue(item, endKey, zone);
  const startRaw = readPropertyText(item, startKey);

  return {
    item,
    start,
    end,
    startRaw,
    endRaw: endKey === null ? '' : readPropertyText(item, endKey),
    unreadable: start === null && startRaw.length > 0,
    placement: placeSpan(axis, start, end),
  };
}

/**
 * Why this timeline cannot be drawn, or null when it can.
 *
 * The same shape the calendar uses - and, in this file, the same word `view-chrome` uses for the
 * state. Core's own `unrenderable` list is consulted first because it is the authority on a view
 * whose configuration has drifted; the schema check catches the same drift locally when Core has
 * not flagged it.
 *
 * **Only the start is asked about.** A missing end property leaves a timeline of milestones, which
 * is drawable, so it is reported above the grid rather than instead of it.
 */
export function describeUndrawable(
  view: View,
  schema: EffectiveSchema | null,
  views: ContainerViews | null,
): string | null {
  if (views?.unrenderable.includes(view.id) === true) {
    return `Core reports that "${view.name}" can no longer be drawn: the property its bars started from is gone or no longer fits. The items are untouched, and another view will show them.`;
  }

  if (view.dateProperty === null) {
    return NO_START_PROPERTY;
  }

  // A container with no schema - a workspace root - cannot be checked, and refusing to draw on that
  // basis would call a perfectly good timeline broken. The values are still validated as they are
  // read, so an item carrying something that is not a date lands in a band below rather than in a
  // wrong column.
  if (schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.dateProperty);

  if (definition === undefined) {
    return `This timeline starts its bars from "${view.dateProperty}", and that property is not in this item's schema. It was probably removed. The items are all still here; a list view will show them.`;
  }

  // A bar can start from a date (all-day) or a timestamp (a moment that carries a day).
  if (!isDateShaped(definition.type)) {
    return `This timeline starts its bars from "${definition.label}", which is a ${propertyTypeWord(definition.type)} property rather than a date. There is no day to start from, so nothing can be drawn.`;
  }

  return null;
}

/**
 * What the notice above the grid says about an end property that is gone, or null when none is.
 *
 * Modelled on the gallery's lost cover, and for the same reason: the property was one edit made by
 * somebody who has never seen this view, and every item is still on screen. The sentence somebody
 * needs is not "your end dates are missing" but "your items are not".
 */
export function describeLostEndProperty(view: View, schema: EffectiveSchema | null): string | null {
  if (view.endDateProperty === null || schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.endDateProperty);
  const still = 'Every item is still here, drawn as a milestone on the day it starts.';

  if (definition === undefined) {
    return `Bars ended on "${view.endDateProperty}", which is no longer one of this item's properties. ${still}`;
  }

  // The type is named by its label rather than by the stored token: somebody who chose "Date and
  // time" from a list should not be told their property is now a "timestamp".
  return isDateShaped(definition.type)
    ? null
    : `Bars ended on "${definition.label}", which is now a ${propertyTypeWord(definition.type)} property rather than a date. ${still}`;
}

/**
 * What a property is called mid-sentence.
 *
 * Falls back to plain English rather than to the stored key: a container whose schema request
 * degraded would otherwise put "these have no start_date yet" in front of somebody, which is
 * database jargon in a sentence meant to reassure them.
 */
export function propertyWord(
  schema: EffectiveSchema | null,
  key: string,
  fallback: string,
): string {
  const definition = schema?.properties.find((property) => property.key === key);
  return definition === undefined ? fallback : definition.label.toLowerCase();
}

/** Where an item sits right now, said out loud for somebody who has just moved it. */
export function describeWhere(placed: Placed, axis: TimelineWindow): string {
  switch (placed.placement.kind) {
    case 'span':
    case 'milestone':
      return `Drawn on the axis, in ${axis.label}.`;
    case 'reversed':
      return 'Listed below: its end date falls before its start date.';
    case 'outside':
      return `Listed below: dated outside ${axis.label}.`;
    default:
      return placed.unreadable
        ? 'Listed below: its start is not a date this view can read.'
        : 'Listed below as unscheduled.';
  }
}

/** Everything a row or an off-axis entry needs to draw itself and to reach the reschedule panel. */
export interface AsideContext {
  readonly onOpen: (itemId: string) => void;
  readonly rescheduling: string | null;
  readonly setRescheduling: (itemId: string | null) => void;

  /** The one panel every toggle in the view points at. */
  readonly panelId: string;

  readonly schema: EffectiveSchema | null;
  readonly startKey: string;
  readonly endKey: string | null;
  readonly setProperties: (
    itemId: string,
    properties: Record<string, unknown>,
  ) => Promise<string | null>;
}
