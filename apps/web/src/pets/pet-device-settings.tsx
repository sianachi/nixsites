import { Checkbox, Field, Select, Text } from '@nix/ui';
import { useState, type ReactElement, type ReactNode } from 'react';

import {
  PET_SURFACE_OPTIONS,
  readDevicePreference,
  readPetSurface,
  writeDevicePreference,
  type PetSurface,
} from './device-preferences';

/** The device-only rows of the Behaviour group; `children` leads the first row. */
export function PetDeviceSettings({
  inlineWriting,
  children,
}: {
  readonly inlineWriting: boolean;
  readonly children?: ReactNode;
}): ReactElement {
  const [placement, setPlacement] = useState(() => readDevicePreference('placement') || 'right');
  const [inlineContext, setInlineContext] = useState(
    () => readDevicePreference('inlineContext') === 'true',
  );
  const [surface, setSurface] = useState<PetSurface>(() => readPetSurface());
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-end gap-x-4 gap-y-2">
        {children}
        <div
          role="group"
          aria-label="This device"
          className="flex min-w-0 flex-wrap items-end gap-3"
        >
          <Field label="Chat opens">
            {(control) => (
              <Select
                {...control}
                value={surface}
                onChange={(event) => {
                  const value = PET_SURFACE_OPTIONS.find(
                    (option) => option.value === event.currentTarget.value,
                  )?.value;
                  if (!value) return;
                  setSurface(value);
                  writeDevicePreference('surface', value);
                }}
              >
                {PET_SURFACE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {surface !== 'page' ? (
            <Field label="Position">
              {(control) => (
                <Select
                  {...control}
                  value={placement}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setPlacement(value);
                    writeDevicePreference('placement', value);
                  }}
                >
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </Select>
              )}
            </Field>
          ) : null}
          <DeviceTag />
        </div>
      </div>
      {inlineWriting ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3">
            <Checkbox
              label="Send note context with inline AI"
              checked={inlineContext}
              onChange={(event) => {
                setInlineContext(event.currentTarget.checked);
                writeDevicePreference('inlineContext', String(event.currentTarget.checked));
              }}
            />
            <DeviceTag />
          </div>
          <Text variant="note" tone="muted">
            When inline AI is enabled, also sends up to 32 KB of this note to your connected model.
            Off by default; otherwise only the command's text is sent.
          </Text>
        </div>
      ) : null}
    </>
  );
}

function DeviceTag(): ReactElement {
  return (
    <Text as="span" variant="caption" tone="muted">
      This device
    </Text>
  );
}
