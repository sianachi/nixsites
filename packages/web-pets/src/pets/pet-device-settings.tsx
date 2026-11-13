import { Checkbox, Field, Select, Text } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import {
  PET_SURFACE_OPTIONS,
  readDevicePreference,
  readPetSurface,
  writeDevicePreference,
  type PetSurface,
} from '@nix/web-foundation/lib/device-preferences';

/** The device-only rows of the Behaviour group. */
export function PetDeviceSettings({
  inlineWriting,
}: {
  readonly inlineWriting: boolean;
}): ReactElement {
  const [placement, setPlacement] = useState(() => readDevicePreference('placement') || 'right');
  const [inlineContext, setInlineContext] = useState(
    () => readDevicePreference('inlineContext') === 'true',
  );
  const [surface, setSurface] = useState<PetSurface>(() => readPetSurface());
  return (
    <>
      <div role="group" aria-label="This device" className="flex min-w-0 flex-wrap items-end gap-3">
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
        {surface !== 'page' && surface !== 'drawer' ? (
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
