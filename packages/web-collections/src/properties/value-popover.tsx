import { Popover, Text, cn, focusRing } from '@nix/ui';
import { createContext, useContext, useRef, type ReactNode } from 'react';

import { PropertyValueDisplay, hasDisplayValue, type ValueDensity } from './property-value-display';
import type { PropertyDefinition, PropertyOwner } from '../core/container-model';

/**
 * Single-choice fields: picking the value is the whole edit, so the popover closes once it is stored.
 * Dates are left out: a native date input fires a complete `change` while digits are still being typed.
 */
const DISCRETE_TYPES: ReadonlySet<string> = new Set([
  'select',
  'priority',
  'checkbox',
  'completion',
  'assignee',
]);

const TYPED_INPUTS: ReadonlySet<string> = new Set(['text', 'number', 'url', 'date', 'time']);

const TrackWriteContext = createContext<(done: Promise<boolean>) => void>(() => undefined);

/**
 * For the editor inside a `ValuePopover`: hand over the write it just started, resolving true once
 * it was stored. A stored write closes the popover (focus back on the trigger) for single-choice
 * fields, and for a typed field that was finished with Enter. A refused write leaves it open, so the
 * refusal the editor shows stays on screen.
 */
export function useTrackWrite(): (done: Promise<boolean>) => void {
  return useContext(TrackWriteContext);
}

/**
 * Wraps the editor so Enter in a typed field means "done" without hiding a refusal: the field
 * commits on Enter itself, and then this closes - at once when nothing was written or the field is
 * showing its own error, otherwise once the write is stored.
 */
function PopoverBody(props: {
  readonly close: () => void;
  readonly discrete: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { close, discrete, children } = props;
  const finishing = useRef(false);
  const writing = useRef(false);

  const track = (done: Promise<boolean>): void => {
    writing.current = true;
    void done.then((stored) => {
      writing.current = false;
      if (stored && (discrete || finishing.current)) close();
      finishing.current = false;
    });
  };

  return (
    <TrackWriteContext value={track}>
      {/* The panel is a DOM child of a card or row that has a long-press menu: without this, holding
          a finger in the editor would open that menu instead of selecting text. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        data-context-menu-ignore
        onKeyDown={(event) => {
          const field = event.target;
          if (
            event.key !== 'Enter' ||
            !(field instanceof HTMLInputElement) ||
            !TYPED_INPUTS.has(field.type)
          ) {
            return;
          }
          // Otherwise the Enter's keypress lands on the trigger focus returns to and reopens it.
          event.preventDefault();
          finishing.current = true;
          // The field's own handler has run by now: a write is either under way or was not needed.
          queueMicrotask(() => {
            if (writing.current || field.getAttribute('aria-invalid') === 'true') return;
            finishing.current = false;
            close();
          });
        }}
      >
        {children}
      </div>
    </TrackWriteContext>
  );
}

/**
 * One property value on a compact face (a phone row, a gallery card), read-only until tapped.
 * The tap opens the cell's own editor, passed as children, in a popover - so a face is never a
 * form, and there is one edit path. The button is named "<Field> for <Title>" so a screen reader
 * can tell twenty cards' "Category" values apart. An empty value shows the field's name, muted,
 * so it can still be filled in from here; `labelled` puts that name before a filled value too, for
 * faces with no column header to say which field a bare "Ada" belongs to (a card).
 */
export function ValuePopover(props: {
  readonly item: PropertyOwner;
  readonly property: PropertyDefinition;
  readonly density: ValueDensity;
  readonly className?: string;
  readonly labelled?: boolean;
  readonly children: ReactNode;
}): ReactNode {
  const { item, property, density, className, labelled = false, children } = props;
  const label = `${property.label} for ${item.title || 'Untitled'}`;

  return (
    <Popover
      label={label}
      trigger={(trigger) => (
        <button
          {...trigger}
          className={cn(
            'flex min-h-(--control-md) min-w-0 cursor-default items-center rounded-md px-2 text-left any-pointer-coarse:min-h-(--control-lg)',
            focusRing,
            className,
          )}
        >
          {/* Spoken first, so a screen reader hears "Status for Plan, Done" rather than the value alone. */}
          <span className="sr-only">{hasDisplayValue(item, property) ? `${label}, ` : label}</span>
          {hasDisplayValue(item, property) ? (
            <>
              {labelled ? (
                <span aria-hidden className="mr-2 shrink-0">
                  <Text as="span" variant="caption" tone="muted">
                    {property.label}
                  </Text>
                </span>
              ) : null}
              <PropertyValueDisplay item={item} property={property} density={density} />
            </>
          ) : (
            // Text does not forward aria-hidden, so the muted name is hidden by its wrapper.
            <span aria-hidden className="min-w-0">
              <Text as="span" variant="caption" tone="muted" truncate>
                {property.label}
              </Text>
            </span>
          )}
        </button>
      )}
    >
      {({ close }) => (
        <PopoverBody close={close} discrete={DISCRETE_TYPES.has(property.type)}>
          {children}
        </PopoverBody>
      )}
    </Popover>
  );
}
