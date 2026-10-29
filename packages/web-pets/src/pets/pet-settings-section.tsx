import {
  petSettingsSchema,
  petProviderSchema,
  type PetProfile,
  type PetSettings,
  type PetSettingsResponse,
} from '@nix/api-client';
import { Button, Checkbox, Field, Icon, Input, Menu, Select, Text, Textarea } from '@nix/ui';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useId, useState, type ReactElement } from 'react';
import { newPet, petCatalog } from './catalog';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import { PetAvatar } from './pet-avatar';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetProviderKeys } from './pet-provider-keys';
import { PetDeviceSettings } from './pet-device-settings';
import { PetMemorySection } from './pet-memory-section';
import { SettingsSection } from '@nix/web-settings/settings/shared/settings-section';

export function PetSettingsSection(): ReactElement {
  const state = usePetSettings();
  return (
    <SettingsSection
      title="Your companions"
      summary="Pick a provider, character and tone; pets follow your account across workspaces"
    >
      {state.loading ? <Text role="status">Loading your pets…</Text> : null}
      {state.error ? (
        <div className="flex flex-col gap-2">
          <Text role="alert">{state.error}</Text>
          <Button variant="secondary" onClick={state.reload} disabled={state.saving}>
            Reload saved settings
          </Button>
        </div>
      ) : null}
      {state.saved ? (
        <PetSettingsEditor
          initial={state.saved}
          saving={state.saving || state.loading}
          onSave={state.save}
        />
      ) : null}
    </SettingsSection>
  );
}

interface EditorProps {
  readonly initial: PetSettingsResponse;
  readonly saving: boolean;
  readonly onSave: (settings: PetSettings) => Promise<boolean>;
}

export function PetSettingsEditor({ initial, saving, onSave }: EditorProps): ReactElement {
  const [previousInitial, setPreviousInitial] = useState(initial);
  const [draft, setDraft] = useState(initial.settings);
  const [selectedId, setSelectedId] = useState(
    initial.settings.activePetId ?? initial.settings.profiles[0]?.id ?? null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const tiles = useId();
  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    if (JSON.stringify(draft) !== JSON.stringify(initial.settings)) {
      setDraft(initial.settings);
      setSelectedId(
        initial.settings.profiles.some((profile) => profile.id === selectedId)
          ? selectedId
          : (initial.settings.activePetId ?? initial.settings.profiles[0]?.id ?? null),
      );
      setMessage(null);
    }
  }
  const pet = draft.profiles.find((profile) => profile.id === selectedId) ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.settings);

  function change(next: PetSettings): void {
    setDraft(next);
    setMessage(null);
  }
  function updatePet(update: Partial<PetProfile>): void {
    change({
      ...draft,
      profiles: draft.profiles.map((profile) =>
        profile.id === selectedId ? { ...profile, ...update } : profile,
      ),
    });
  }
  function add(profile: PetProfile): void {
    change({
      ...draft,
      activePetId: draft.activePetId ?? profile.id,
      profiles: [...draft.profiles, profile],
    });
    setSelectedId(profile.id);
  }
  function remove(): void {
    const profiles = draft.profiles.filter((profile) => profile.id !== selectedId);
    change({
      ...draft,
      profiles,
      enabled: profiles.length > 0 && draft.enabled,
      activePetId: draft.activePetId === selectedId ? (profiles[0]?.id ?? null) : draft.activePetId,
    });
    setSelectedId(profiles[0]?.id ?? null);
  }

  async function saveSettings(): Promise<boolean> {
    // A memory emptied in place is one the owner forgot, not a reason to refuse the whole form.
    const parsed = petSettingsSchema.safeParse({
      ...draft,
      memories: draft.memories?.filter((memory) => memory.text.trim() !== ''),
    });
    if (!parsed.success) {
      setMessage('Check the name and settings of each pet before saving.');
      return false;
    }
    if (!dirty) return true;
    const ok = await onSave(parsed.data);
    if (ok) {
      setDraft(parsed.data);
      setMessage('Pet settings saved.');
    }
    return ok;
  }

  const motionField = (
    <Field label="Motion">
      {(control) => (
        <Select
          {...control}
          value={draft.motion}
          onChange={(event) => {
            change({ ...draft, motion: event.currentTarget.value as PetSettings['motion'] });
          }}
        >
          <option value="system">System</option>
          <option value="reduced">Reduced</option>
          <option value="full">Full</option>
        </Select>
      )}
    </Field>
  );

  return (
    <form
      className="@container flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSettings();
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Saved pets</legend>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div
            role="radiogroup"
            aria-label="Companions"
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            {draft.profiles.map((profile) => (
              <label
                key={profile.id}
                className="relative flex w-24 min-w-0 cursor-pointer flex-col items-center gap-1 border border-divider p-2 has-checked:border-accent has-focus-visible:outline-2 has-focus-visible:outline-accent"
              >
                <input
                  type="radio"
                  name={tiles}
                  className="sr-only"
                  checked={profile.id === selectedId}
                  onChange={() => {
                    setSelectedId(profile.id);
                  }}
                />
                <span aria-hidden>
                  <PetAvatar appearance={profile.appearance} motion="reduced" size="compact" />
                </span>
                <Text as="span" variant="caption" truncate>
                  {profile.name || 'Unnamed pet'}
                </Text>
                {profile.id === draft.activePetId ? (
                  <>
                    <span
                      aria-hidden
                      className="absolute right-1 top-1 size-2 rounded-full bg-accent-fill"
                    />
                    <span className="sr-only">, active</span>
                  </>
                ) : null}
              </label>
            ))}
            <Button
              type="button"
              variant="icon"
              aria-label="Add pet"
              disabled={draft.profiles.length >= 12}
              onClick={() => {
                add(newPet());
              }}
            >
              <Icon icon={Plus} size="sm" />
            </Button>
          </div>
          {pet ? (
            <div className="flex items-center gap-2">
              {pet.id === draft.activePetId ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    change({ ...draft, activePetId: pet.id });
                  }}
                >
                  Use this pet
                </Button>
              )}
              <Menu
                label="Pet actions"
                items={[
                  {
                    label: 'Duplicate pet',
                    disabled: draft.profiles.length >= 12,
                    onSelect: () => {
                      add({
                        ...pet,
                        id: crypto.randomUUID(),
                        name: `${pet.name.slice(0, 75)} copy`,
                      });
                    },
                  },
                  { label: 'Remove pet', destructive: true, onSelect: remove },
                ]}
              >
                {(trigger) => (
                  <Button {...trigger} variant="icon" aria-label="Pet actions">
                    <Icon icon={MoreHorizontal} size="sm" />
                  </Button>
                )}
              </Menu>
            </div>
          ) : null}
        </div>
        {pet ? (
          <>
            <div className="grid min-w-0 gap-3 @lg:grid-cols-2 @3xl:grid-cols-4">
              <Field label="Name">
                {(control) => (
                  <Input
                    {...control}
                    required
                    maxLength={80}
                    value={pet.name}
                    onChange={(event) => {
                      updatePet({ name: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label="Appearance">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.appearance}
                    onChange={(event) => {
                      updatePet({
                        appearance: event.currentTarget.value as PetProfile['appearance'],
                      });
                    }}
                  >
                    {petCatalog.map((entry) => (
                      <option key={entry.appearance} value={entry.appearance}>
                        {entry.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Personality">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.personality}
                    onChange={(event) => {
                      updatePet({
                        personality: event.currentTarget.value as PetProfile['personality'],
                      });
                    }}
                  >
                    <option value="calm">Calm and thoughtful</option>
                    <option value="playful">Playful and inventive</option>
                    <option value="encouraging">Encouraging and practical</option>
                    <option value="concise">Concise and composed</option>
                  </Select>
                )}
              </Field>
              <Field label="Response length">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.responseLength}
                    onChange={(event) => {
                      updatePet({
                        responseLength: event.currentTarget.value as PetProfile['responseLength'],
                      });
                    }}
                  >
                    <option value="concise">Concise</option>
                    <option value="balanced">Balanced</option>
                    <option value="detailed">Detailed</option>
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
              <Field label="Model">
                {(control) => (
                  <Select
                    {...control}
                    value={pet.provider}
                    onChange={(event) => {
                      updatePet({ provider: petProviderSchema.parse(event.currentTarget.value) });
                    }}
                  >
                    <option value="chatgpt">ChatGPT</option>
                    <option value="anthropic">Claude</option>
                    <option value="openrouter">OpenRouter</option>
                  </Select>
                )}
              </Field>
              {pet.provider === 'chatgpt' ? (
                <PetConnectionPanel collapsible />
              ) : (
                <PetProviderKeys
                  key={pet.provider}
                  collapsible
                  provider={pet.provider}
                  onSaveSettings={saveSettings}
                  needsProviderSave={
                    initial.settings.profiles.find((saved) => saved.id === pet.id)?.provider !==
                    pet.provider
                  }
                />
              )}
            </div>
            <PetInstructions
              key={pet.id}
              value={pet.instructions}
              onChange={(instructions) => {
                updatePet({ instructions });
              }}
            />
            <Checkbox
              label="Apply changes without asking"
              checked={pet.applyWithoutAsking}
              onChange={(event) => {
                updatePet({ applyWithoutAsking: event.currentTarget.checked });
              }}
            />
          </>
        ) : (
          <Text variant="note" tone="muted">
            Add your first pet to choose its appearance and personality.
          </Text>
        )}
        <Text variant="h5" as="h3">
          Behaviour
        </Text>
        <Checkbox
          label="Show companion in my workspaces"
          checked={draft.enabled}
          disabled={draft.activePetId === null}
          onChange={(event) => {
            change({ ...draft, enabled: event.currentTarget.checked });
          }}
        />
        <div className="flex flex-col gap-1">
          <Checkbox
            label="Use AI while writing notes"
            checked={draft.inlineWriting}
            disabled={draft.activePetId === null || !draft.enabled}
            onChange={(event) => {
              change({ ...draft, inlineWriting: event.currentTarget.checked });
            }}
          />
          <Text variant="note" tone="muted">
            The text you select is sent to your connected model. Locked notes are never sent.
          </Text>
        </div>
        {draft.enabled ? (
          <PetDeviceSettings inlineWriting={draft.inlineWriting}>{motionField}</PetDeviceSettings>
        ) : (
          motionField
        )}
        <PetMemorySection
          memories={draft.memories ?? []}
          memoryOff={draft.memoryOff ?? false}
          onChange={(memories, memoryOff) => {
            change({ ...draft, memories, memoryOff });
          }}
        />
      </fieldset>
      {message ? (
        <Text role="status" variant="note">
          {message}
        </Text>
      ) : null}
      {dirty ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-divider bg-background py-3">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Text variant="note" tone="muted">
            Unsaved changes
          </Text>
        </div>
      ) : null}
    </form>
  );
}

/** Collapsed until needed; opens on mount only when the pet already has instructions. */
function PetInstructions({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  const [open] = useState(value !== '');
  return (
    <details open={open}>
      <summary className="min-h-11 cursor-pointer text-sm text-accent-text any-pointer-coarse:min-h-(--control-lg)">
        Instructions (optional)
      </summary>
      <Field
        label="Personal instructions"
        hint="How you like to work; this never grants extra access"
      >
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            maxLength={2000}
            value={value}
            onChange={(event) => {
              onChange(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    </details>
  );
}
