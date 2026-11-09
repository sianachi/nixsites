import { useId, type ReactElement, type ReactNode } from 'react';

import { Checkbox, Text, useUndo } from '@nix/ui';

import { useSavedMark } from './saved-mark';

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
  /** True when the change waits for a Save button, so it neither says "Saved" nor joins the undo history. */
  readonly draft?: boolean;
  /** Detail behind the one-line description, kept in a "More" disclosure. */
  readonly more?: ReactNode;
}): ReactElement {
  const descriptionId = useId();
  const undo = useUndo();
  const saved = useSavedMark();
  const { onChange, label } = props;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-3">
        <Checkbox
          label={label}
          checked={props.checked}
          disabled={props.disabled}
          aria-describedby={descriptionId}
          onChange={(event) => {
            const next = event.target.checked;
            onChange(next);
            if (props.draft === true) return;
            saved.show();
            undo.push(`Turned ${next ? 'on' : 'off'} “${label}”`, () => {
              onChange(!next);
              saved.show();
            });
          }}
        />
        {props.draft === true ? null : saved.mark}
      </div>
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
