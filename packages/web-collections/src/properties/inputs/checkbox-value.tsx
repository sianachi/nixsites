import { Checkbox } from '@nix/ui';
import { type ReactNode } from 'react';

import { type PropertyInputProps } from './types';
import { ValueShell } from './shell';

export function CheckboxValue(props: PropertyInputProps): ReactNode {
  const { item, property, onCommit, disabled = false } = props;

  // True or false, never null: a checkbox has two states and "unchecked" is one of them rather than
  // an absence. Clearing a checkbox property is a schema question, not a click.
  const checked = item.properties[property.key] === true;

  return (
    <ValueShell {...props}>
      {(control) => (
        <Checkbox
          {...control}
          checked={checked}
          required={property.required}
          disabled={disabled}
          className="self-start"
          onChange={(event) => {
            onCommit(event.target.checked);
          }}
        />
      )}
    </ValueShell>
  );
}
