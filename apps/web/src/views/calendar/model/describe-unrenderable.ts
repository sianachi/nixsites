import type {
  ContainerViews,
  EffectiveSchema,
  View,
} from '../../../collections/core/container-model';
import { isDateShaped } from '../../../collections/core/property-types';

export const NO_DATE_PROPERTY =
  'A calendar places items by a date property, and this view does not name one. Nothing has been ' +
  'lost - every item is still here, and a list or board view will show them.';

/**
 * Why this calendar cannot be drawn, or null when it can.
 *
 * An empty month and a broken month look identical, so the difference has to be stated. Core's own
 * `unrenderable` list is consulted first because it is the authority on a view whose configuration
 * has drifted; the schema check catches the same drift locally when Core has not flagged it.
 */
export function describeUnrenderable(
  view: View,
  schema: EffectiveSchema | null,
  views: ContainerViews | null,
): string | null {
  if (views?.unrenderable.includes(view.id) === true) {
    return `Core reports that "${view.name}" can no longer be drawn: the property it placed items by is gone or no longer fits. The items are untouched, and another view will show them.`;
  }

  if (view.dateProperty === null) {
    return NO_DATE_PROPERTY;
  }

  // A container with no schema - a workspace root - cannot be checked, and refusing to draw on that
  // basis would call a perfectly good calendar broken. The values are still validated as they are
  // read, so an item carrying something that is not a date lands in "unscheduled" rather than in a
  // wrong cell.
  if (schema === null) {
    return null;
  }

  const definition = schema.properties.find((property) => property.key === view.dateProperty);

  if (definition === undefined) {
    return `This calendar places items by "${view.dateProperty}", and that property is not in this item's schema. It was probably removed. The items are all still here; a list view will show them.`;
  }

  // Every calendar-placeable type, not only a plain date or timestamp: due_date, start_date and
  // datetime all name a day too, the same set `isDateShaped` already draws the view-kind picker's
  // line from. A narrower check here used to call a perfectly good due-date or start-date calendar
  // broken.
  if (!isDateShaped(definition.type)) {
    return `This calendar places items by "${definition.label}", which is a ${definition.type} property rather than a date or a time. There is no day to put an item on, so nothing can be drawn.`;
  }

  return null;
}
