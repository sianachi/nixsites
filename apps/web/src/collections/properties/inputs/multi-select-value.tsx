import { Button, Checkbox, Field, Input } from '@nix/ui';
import { useState, type ReactNode } from 'react';

import { ValuePopover } from '../value-popover';

import { type PropertyInputProps } from './types';
import { GroupShell } from './shell';
import { useMultiSelectDraft } from './drafts';

type MultiSelectProps = PropertyInputProps & {
  readonly custom?: boolean;
  readonly hint?: string;
};

/**
 * A table cell shows the choices as one line and opens the same checkbox list in a popover, so a
 * six-option field is one row tall rather than six. Everywhere else the list is drawn in place.
 */
export function MultiSelectValue(props: MultiSelectProps): ReactNode {
  if (props.density === 'cell') {
    return (
      <ValuePopover item={props.item} property={props.property} density="cell">
        <MultiSelectGroup {...props} density="card" />
      </ValuePopover>
    );
  }
  return <MultiSelectGroup {...props} />;
}

function MultiSelectGroup(props: MultiSelectProps): ReactNode {
  const { item, property, onCommit, disabled = false } = props;

  const [newValue, setNewValue] = useState('');
  const raw: unknown = item.properties[property.key];
  const stored = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string' && raw.length > 0
      ? [raw]
      : [];

  const { selection, toggle } = useMultiSelectDraft(stored, onCommit);

  // Declared order, always: a checkbox list has no "Recent" group to offer, and reordering the
  // boxes themselves would move a box out from under somebody ticking several in a row.
  const options = [
    ...property.options,
    // Same reason as the select: a value the schema no longer declares is still on the item, and a
    // control that hid it would report the item as holding less than it does.
    ...selection.filter((value) => !property.options.includes(value)),
  ];

  // A fieldset rather than <Field>, which wires a label to one control by id. A group of checkboxes
  // has no single control to point at, so the group is named by its legend instead.
  return (
    <GroupShell {...props}>
      {(group) => (
        <>
          {options.map((option) => (
            <Checkbox
              key={option}
              label={option}
              tabIndex={props.tabIndex}
              checked={selection.includes(option)}
              aria-describedby={group['aria-describedby']}
              aria-invalid={group['aria-invalid']}
              onKeyDown={(event) => {
                // Native checkboxes reserve Space for activation, but property fields are also used
                // in grid-style editing where Enter commits the focused value. Honour both without
                // submitting an enclosing form or letting Enter fall through to the editor.
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.click();
                }
              }}
              onChange={(event) => {
                toggle(option, event.target.checked);
              }}
            />
          ))}

          {props.custom ? (
            <div className="flex items-end gap-2">
              <Field label={`New value for ${property.label}`} className="min-w-0 flex-1">
                {(control) => (
                  <Input
                    {...control}
                    value={newValue}
                    onChange={(event) => {
                      setNewValue(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (newValue.trim() && !selection.includes(newValue.trim())) {
                          toggle(newValue.trim(), true);
                          setNewValue('');
                        }
                      }
                    }}
                  />
                )}
              </Field>
              <Button
                disabled={disabled || !newValue.trim() || selection.includes(newValue.trim())}
                onClick={() => {
                  toggle(newValue.trim(), true);
                  setNewValue('');
                }}
              >
                Add
              </Button>
            </div>
          ) : null}
        </>
      )}
    </GroupShell>
  );
}
