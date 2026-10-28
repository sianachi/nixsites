import type { StaleMember } from '@nix/web-foundation/lib/suggest/staleness';
import {
  readSelectValue,
  type Item,
  type PropertyDefinition,
  type View,
} from '../core/container-model';
import { canGroupBy } from '../core/property-types';
import type { ContainerData } from '../core/use-container';

export interface BoardColumn {
  /** The property value this column writes, or null for the unset column. */
  readonly value: string | null;
  readonly label: string;
  readonly items: readonly Item[];
}

export const NO_STALE: ReadonlyMap<string, StaleMember> = new Map();

/** Every loaded child's age, bucketed by its grouping value: one group per board column. */
export function columnAges(
  children: readonly Item[],
  key: string,
  now: number,
): readonly (readonly { readonly id: string; readonly ageMs: number }[])[] {
  const groups = new Map<string | null, { id: string; ageMs: number }[]>();
  for (const item of children) {
    const value = readSelectValue(item, key);
    const member = { id: item.id, ageMs: Math.max(0, now - Date.parse(item.updatedAt)) };
    const group = groups.get(value);
    if (group === undefined) {
      groups.set(value, [member]);
    } else {
      group.push(member);
    }
  }
  return [...groups.values()];
}

/**
 * What a stale-card dismissal is about: this card, as it was when the note was waved away. An edit
 * moves `updatedAt`, which makes the key new, so the note can return if the card goes stale again.
 */
export function staleDismissalKey(item: Item): string {
  return `stale:${item.workspaceId}:${item.id}:${item.updatedAt}`;
}

/**
 * Why a board might not be drawable, as data rather than as four scattered early returns.
 *
 * Keeping the reason means the explanation can name the actual problem - a deleted property, a
 * property that is a date - instead of the generic apology a boolean would leave room for.
 */
export type Grouping =
  | { readonly kind: 'ready'; readonly property: PropertyDefinition }
  | { readonly kind: 'ungrouped' }
  | { readonly kind: 'missing'; readonly key: string }
  | { readonly kind: 'wrongType'; readonly property: PropertyDefinition }
  | { readonly kind: 'flagged'; readonly property: PropertyDefinition };

export function resolveGrouping(container: ContainerData, view: View): Grouping {
  if (view.groupBy === null || view.groupBy.length === 0) {
    return { kind: 'ungrouped' };
  }

  const property = container.schema?.properties.find((candidate) => candidate.key === view.groupBy);

  if (property === undefined) {
    return { kind: 'missing', key: view.groupBy };
  }

  if (!canGroupBy(property.type)) {
    return { kind: 'wrongType', property };
  }

  // Core keeps its own list of views it considers unrenderable. When it disagrees with the check
  // above, Core is the one holding the schema this build has not seen, so it wins.
  if ((container.views?.unrenderable ?? []).includes(view.id)) {
    return { kind: 'flagged', property };
  }

  return { kind: 'ready', property };
}

export function describeUnrenderable(
  grouping: Exclude<Grouping, { kind: 'ready' }>,
  view: View,
): { readonly title: string; readonly detail: string } {
  switch (grouping.kind) {
    case 'ungrouped':
      return {
        title: 'This board has no grouping property',
        detail: `"${view.name}" is a board, but nothing says which property its columns come from. Give the view a select property to group by and the columns will appear.`,
      };

    case 'missing':
      return {
        title: 'This board groups by a property that no longer exists',
        detail: `"${view.name}" groups by "${grouping.key}", which is not in this item's schema. The items are all still here - it is the property that is gone, so the board cannot say which column each one belongs in.`,
      };

    case 'wrongType':
      return {
        title: 'This board groups by a property that cannot make columns',
        detail: `"${grouping.property.label}" is a ${grouping.property.type} property, and a board's columns come from a select. The items are all still here; only this view cannot draw them.`,
      };

    case 'flagged':
      return {
        title: 'This board cannot be drawn',
        detail: `Core reports that "${view.name}" can no longer be rendered as configured. The items are all still here; the view needs a grouping property it can use.`,
      };
  }
}
