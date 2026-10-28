import { useId, type ReactElement, type ReactNode } from 'react';

import { Checkbox, Text } from '@nix/ui';

/** Caption for a setting that never leaves this browser. */
export function DeviceOnlyNote(): ReactElement {
  return (
    <Text as="p" variant="caption" tone="muted">
      This device only
    </Text>
  );
}

/**
 * One on/off preference: a checkbox named by its label and described by the note under it, so a
 * screen reader hears what the switch covers when it lands on it, not only after reading on.
 */
export function PreferenceToggle(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly description: string;
  readonly unsaved: string | null;
  /** True for a setting that never leaves this browser. */
  readonly deviceOnly?: boolean;
  readonly disabled?: boolean;
  /** Detail behind the one-line description, kept in a "More" disclosure. */
  readonly more?: ReactNode;
}): ReactElement {
  const descriptionId = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <Checkbox
        label={props.label}
        checked={props.checked}
        disabled={props.disabled}
        aria-describedby={descriptionId}
        onChange={(event) => {
          props.onChange(event.target.checked);
        }}
      />
      {/* Indented past the checkbox's hit area and gap, so the notes start under the label text. */}
      <div className="flex flex-col gap-0.5 ps-[calc(var(--control-sm)+--spacing(2))] any-pointer-coarse:ps-[calc(var(--control-lg)+--spacing(2))]">
        <Text as="p" id={descriptionId} variant="note" tone="muted">
          {props.description}
        </Text>
        {props.deviceOnly === true ? <DeviceOnlyNote /> : null}
        {props.unsaved === null ? null : (
          <Text as="p" variant="note">
            {props.unsaved}
          </Text>
        )}
        {props.more === undefined ? null : (
          <details>
            <summary className="min-h-11 cursor-pointer text-sm text-accent-text">
              More<span className="sr-only"> about {props.label}</span>
            </summary>
            <Text variant="note" tone="muted">
              {props.more}
            </Text>
          </details>
        )}
      </div>
    </div>
  );
}
