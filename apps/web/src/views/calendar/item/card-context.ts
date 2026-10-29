import type { PropertyDefinition, PropertyValue } from '@nix/web-collections/core/container-model';

/** What every card needs, whether it sits in a day or in the unscheduled list. */
export interface CardContext {
  readonly onOpen: (itemId: string) => void;
  readonly setRescheduling: (itemId: string | null) => void;
  readonly setDragged: (itemId: string, occurrenceDate: string | null) => void;

  /** What a drag that never lands on a target - lifted, then dropped nowhere - clears. */
  readonly clearDragged: () => void;
  readonly moveTo: (itemId: string, values: Record<string, string | null>) => void;

  /**
   * What a drop onto `to` writes for an item last dragged from `from`.
   *
   * `from` is the day the dragged occurrence was drawn on - null when the drag started somewhere
   * with no day of its own (the unscheduled list). When the item has an end configured and set,
   * this shifts both the start and the end by the distance from `from` to `to`, so the whole span
   * moves together rather than just the end the pointer happened to be over - see `spanDates`'s
   * own note on the reversed-span bug this replaces. Anything else - a point item, or a drag with
   * no origin day - falls back to writing only the date property, exactly as before.
   */
  readonly dropOnDate: (itemId: string, from: string | null, to: string) => void;
  /** The reader's zone, so a card on the month grid can say what time its item is at. */
  readonly zone: string;
  readonly secondaryKey: string | null;
  readonly secondaryProperty: PropertyDefinition | null;
  readonly onWrite: (
    itemId: string,
    propertyKey: string,
    value: PropertyValue,
  ) => Promise<string | null>;
  readonly onCreate: (
    title: string,
    properties?: Record<string, unknown>,
  ) => Promise<string | null>;
  readonly dateProperty: string;
}
