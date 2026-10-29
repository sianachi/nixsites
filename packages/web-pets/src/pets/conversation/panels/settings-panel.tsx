import { type PetConnection, type PetProfile } from '@nix/api-client';
import { Button, Checkbox, Icon, Select, Text, focusRing } from '@nix/ui';
import { ArrowLeft } from 'lucide-react';
import { type ReactElement, type RefObject } from 'react';
import { Link } from 'react-router';
import { petProviderLabels } from '../../catalog';

export function PetSettingsPanel({
  pet,
  workspaceId,
  model,
  models,
  running,
  runtime,
  readWithoutAsking,
  headingRef,
  onModelChange,
  onReadWithoutAskingChange,
  onBack,
}: {
  readonly pet: PetProfile;
  readonly workspaceId: string;
  readonly model: string;
  readonly models: NonNullable<PetConnection['models']>;
  readonly running: boolean;
  readonly runtime: PetConnection | null;
  readonly readWithoutAsking: boolean;
  readonly headingRef: RefObject<HTMLDivElement | null>;
  readonly onModelChange: (model: string) => void;
  readonly onReadWithoutAskingChange: (value: boolean) => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-3 @sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <Icon icon={ArrowLeft} size="sm" />
          Back
        </Button>
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <Text as="h3" variant="h3">
            Chat settings
          </Text>
        </div>
      </div>
      <label className="flex flex-col gap-2">
        <Text variant="note">Model</Text>
        <Select
          aria-label="Model"
          value={model}
          disabled={running}
          onChange={(event) => {
            onModelChange(event.currentTarget.value);
          }}
        >
          <option value="">Provider default</option>
          {model && !models.some((entry) => entry.id === model) ? (
            <option value={model}>{model} (checking availability)</option>
          ) : null}
          {models.map((value) => (
            <option key={value.id} value={value.id}>
              {value.supportsTools ? value.name : `${value.name} (cannot use tools)`}
            </option>
          ))}
        </Select>
      </label>
      <Checkbox
        checked={readWithoutAsking}
        onChange={(event) => {
          onReadWithoutAskingChange(event.currentTarget.checked);
        }}
        label={`Read without asking. When Workspace access is on, ${pet.name} can search and read your workspace without asking first. What it reads is sent to ${petProviderLabels[pet.provider]}. Changes ask first unless you turn on Apply without asking in a conversation. Applies on this device.`}
      />
      {runtime?.reason && runtime.status === 'connected' ? (
        <Text variant="note" tone="muted">
          {runtime.reason}
        </Text>
      ) : null}
      <Link to={`/w/${workspaceId}/settings?tab=pets`} className={`underline ${focusRing}`}>
        <Text as="span" variant="note">
          Pet settings
        </Text>
      </Link>
    </div>
  );
}
