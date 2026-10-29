import { useState, type ReactNode } from 'react';

import { readPropertyText } from '../core/container-model';

import { CheckboxValue } from './inputs/checkbox-value';
import { AssigneeValue, PriorityValue, SelectValue } from './inputs/choice-values';
import { ComputedValue, ReadOnlyValue } from './inputs/computed-value';
import { DateTimeValue, DateValue } from './inputs/date-values';
import { ImageValue } from './inputs/image-value';
import { LongTextValue } from './inputs/long-text-value';
import { MultiSelectValue } from './inputs/multi-select-value';
import { ReminderValue, TimestampValue } from './inputs/timestamp-values';
import { TypedValue } from './inputs/typed-value';
import type { PropertyInputProps } from './inputs/types';
import { useFieldChoices } from './use-field-choices';

export type { PropertyInputDensity, PropertyInputProps } from './inputs/types';

/**
 * One control for one property, chosen from what the schema says the property is.
 *
 * **The type is an open set, so this dispatch has to have a floor.** The contract calls a property
 * type a string rather than an enum on purpose: adding a type is a feature, not a parse failure in
 * every client that has not been rebuilt. A build that met an unfamiliar type by rendering nothing
 * would hide a value somebody stored, so the unknown case shows the value as stored, read-only, and
 * says why it cannot be edited here.
 *
 * **Nothing here writes per keystroke.** Typed values commit on blur or on Enter; the discrete ones
 * - a select, a checkbox, a date picked from the field - commit on the choice itself, because the
 * choice is the whole gesture. A control that fired a request per character would put a write
 * behind every letter of a note's owner.
 *
 * Typed drafts keep unsent edits when the stored value moves. A field with no unsent changes follows
 * the refreshed value, and the refreshed value becomes the baseline for cancelling an edit.
 *
 * **Two densities, one set of controls.** The same control is drawn in a property panel, where it
 * needs its own label and its own frame, and in a table cell, where the column header is already
 * the label and the cell already has a rule under it. That is a real prop and not a `className`
 * passed in from the call site: a component whose styling forks at its callers has as many
 * appearances as it has callers, and none of them is the component's.
 */

/** The types this build can edit. Anything else falls through to the read-only case. */
const KNOWN_TYPES = [
  'text',
  'long_text',
  'number',
  'select',
  'multi_select',
  'date',
  'timestamp',
  'datetime',
  'checkbox',
  'url',
  'image',
  'due_date',
  'start_date',
  'completion',
  'priority',
  'estimate',
  'assignee',
  'formula',
  'rollup',
  'reminder',
] as const;

export function isKnownPropertyType(type: string): boolean {
  return (KNOWN_TYPES as readonly string[]).includes(type);
}

export function PropertyInput(props: PropertyInputProps): ReactNode {
  if (
    props.property.choiceSource &&
    ['text', 'select', 'multi_select'].includes(props.property.type)
  ) {
    return <SourcedValue {...props} />;
  }
  return <PropertyControl {...props} />;
}

function SourcedValue(props: PropertyInputProps): ReactNode {
  const [enabled, setEnabled] = useState(false);
  const source = useFieldChoices(props.property, props.item.parentId, enabled);
  const property = {
    ...props.property,
    options: [...new Set([...props.property.options, ...source.values])],
  };
  // The source's hint is the field's own hint, so it is wired to the control and shown only while
  // somebody is in the field, not under every sourced value in a table.
  const hint = enabled && source.hint.length > 0 ? { hint: source.hint } : {};
  return (
    <div
      className="min-w-0"
      onFocusCapture={() => {
        setEnabled(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setEnabled(false);
      }}
    >
      {property.type === 'multi_select' ? (
        <MultiSelectValue {...props} {...hint} property={property} custom />
      ) : (
        <TypedValue {...props} {...hint} kind="text" suggestions={property.options} />
      )}
    </div>
  );
}

function PropertyControl(props: PropertyInputProps): ReactNode {
  switch (props.property.type) {
    case 'text':
      // A one-line field strips line breaks from its value, so a text the API, an import or the
      // pet wrote over several lines is edited as several lines rather than flattened on first edit.
      return /[\r\n]/.test(readPropertyText(props.item, props.property.key)) ? (
        <LongTextValue {...props} />
      ) : (
        <TypedValue {...props} kind="text" />
      );

    case 'long_text':
      return <LongTextValue {...props} />;

    case 'url':
      return <TypedValue {...props} kind="url" />;

    // A picker over an address, because an address is what it holds. **Still not a file picker**:
    // there is no file or media model in this build to pick from, and a control that opened one
    // would be offering something the system cannot store. Choosing, pasting or dragging a picture
    // in all hand over a URL; the upload arrives with the media model.
    case 'image':
      return <ImageValue {...props} />;

    case 'number':
      return <TypedValue {...props} kind="number" />;

    case 'select':
      return <SelectValue {...props} />;

    case 'multi_select':
      return <MultiSelectValue {...props} />;

    case 'date':
      return <DateValue {...props} />;

    case 'timestamp':
      return <TimestampValue {...props} />;

    // A date or a moment: a synced event toggles between all-day and timed from one edit to the
    // next on the provider's side, so this is the one property that has to hold either shape.
    case 'datetime':
      return <DateTimeValue {...props} />;

    case 'checkbox':
      return <CheckboxValue {...props} />;

    // Stored exactly as a timestamp is, but it is an instant somebody is told about rather than a
    // time something happens - see `ReminderValue` for why it is edited in the reader's own zone.
    case 'reminder':
      return <ReminderValue {...props} />;

    // The task types (3.1) edit through the controls of the shapes they store: a due date IS a
    // date to every hand that touches it, and the meaning lives in the schema, not the control.
    case 'due_date':
    case 'start_date':
      return <DateValue {...props} />;

    case 'completion':
      return <CheckboxValue {...props} />;

    case 'priority':
      return <PriorityValue {...props} />;

    case 'estimate':
      return <TypedValue {...props} kind="number" />;

    // A person, chosen from the workspace rather than typed as their identifier - see
    // `AssigneeValue` for why this is not just another select.
    case 'assignee':
      return <AssigneeValue {...props} />;

    // Computed on read and never written - see `ComputedValue` for why both are results rather
    // than fields somebody cannot type into. A formula is evaluated in this build and a rollup
    // arrives folded from the server (ADR-0044); neither is anything a control could write to.
    case 'formula':
    case 'rollup':
      return <ComputedValue {...props} />;

    default:
      return (
        <ReadOnlyValue
          {...props}
          note={`This build does not know the "${props.property.type}" property type, so the value is shown as it is stored and cannot be edited here.`}
        />
      );
  }
}
