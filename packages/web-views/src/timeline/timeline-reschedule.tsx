import { Button, Icon, Text } from '@nix/ui';
import { CalendarClock } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { PropertyInput } from '@nix/web-collections/properties/property-input';
import type {
  EffectiveSchema,
  Item,
  PropertyDefinition,
  PropertyValue,
} from '@nix/web-collections/core/container-model';
import type { AsideContext } from './timeline-model';
import { titleOf } from './timeline-model';

/**
 * The way to the two writes, and in this build the only way to them.
 *
 * Every toggle in the view points at the same panel, which is the one place it is rendered. That is
 * what keeps the keyboard's place when an edit moves an item from the grid to a band below.
 */
export function RescheduleToggle({
  item,
  aside,
}: {
  readonly item: Item;
  readonly aside: AsideContext;
}): ReactNode {
  const open = aside.rescheduling === item.id;

  return (
    <Button
      variant="subtle"
      // Named per item, the way the calendar names its per-card control and the list names its per-
      // row cells: a screen of twelve controls all called "Reschedule" is twelve controls neither a
      // screen reader user nor a test can tell apart.
      aria-label={`Reschedule ${titleOf(item)}`}
      aria-expanded={open}
      aria-controls={aside.panelId}
      className="shrink-0"
      onClick={() => {
        aside.setRescheduling(open ? null : item.id);
      }}
    >
      <Icon icon={CalendarClock} size="sm" />
    </Button>
  );
}

/**
 * A start field and an end field, each committing its own key.
 *
 * **Two independent writes, never one.** This is the property panel's rule, and it matters more
 * here than anywhere: the server does not refuse an end that falls before its start - it cannot,
 * because two independent writes are never both valid at every instant - so an invalid end must not
 * be able to block a valid start edit. One combined write would make correcting a reversed pair
 * depend on which end you happened to fix first, which is precisely the ordering trap the server
 * declines to create.
 *
 * Each field therefore carries its own refusal, in the field that caused it - and this view draws
 * no banner, because that would be the same refusal a second time.
 */
export function RescheduleFields({
  item,
  aside,
}: {
  readonly item: Item;
  readonly aside: AsideContext;
}): ReactNode {
  const [startError, setStartError] = useState<string | null>(null);
  const [endError, setEndError] = useState<string | null>(null);

  function commit(
    key: string,
    value: PropertyValue,
    report: (refusal: string | null) => void,
  ): void {
    report(null);
    void aside.setProperties(item.id, { [key]: value }).then(report);
  }

  const start = resolveDateProperty(aside.schema, aside.startKey, 'Start date');
  const end =
    aside.endKey === null ? null : resolveDateProperty(aside.schema, aside.endKey, 'End date');

  return (
    // Cap the desktop measure by the pane width, since a split pane can be narrower than a phone.
    <div className="flex flex-wrap items-start gap-3">
      <div className="w-full min-w-0 max-w-full sm:w-56">
        <PropertyInput
          item={item}
          property={start}
          error={startError}
          onCommit={(value) => {
            commit(start.key, value, setStartError);
          }}
        />
      </div>

      {end === null ? (
        // Not an empty box and not a disabled field: this view names no end property at all, so
        // there is nothing here to edit and saying why is the honest answer. The measure is capped
        // only from `sm` up, like the fields beside it: at the base width the container is already
        // narrower than the cap.
        <Text variant="caption" tone="muted" className="max-w-full sm:max-w-[16rem]">
          This timeline names no end date property, so every item on it is a milestone. Choose one
          under Views to give these bars a length.
        </Text>
      ) : (
        <div className="w-full min-w-0 max-w-full sm:w-56">
          <PropertyInput
            item={item}
            property={end}
            error={endError}
            onCommit={(value) => {
              commit(end.key, value, setEndError);
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The declared property, or a plain date field standing in for it.
 *
 * A container with no schema - a workspace root, or an item whose schema request degraded - can
 * still hold a view naming a property, and the timeline draws in that case rather than refusing.
 * Withdrawing the reschedule control there would leave the keyboard with no way to change a date at
 * all, which is the one thing this build promises. `date` is the honest stand-in: a stored value
 * that turns out to be a timestamp is shown read-only by `PropertyInput` with the reason, rather
 * than being overwritten. The label is plain English rather than the key, so a degraded schema does
 * not put a column name in front of somebody.
 */
function resolveDateProperty(
  schema: EffectiveSchema | null,
  key: string,
  fallbackLabel: string,
): PropertyDefinition {
  return (
    schema?.properties.find((property) => property.key === key) ?? {
      key,
      label: fallbackLabel,
      type: 'date',
      options: [],
      required: false,
    }
  );
}
