import {
  petSettingsSchema,
  petProviderSchema,
  type PetProfile,
  type PetSettings,
  type PetSettingsResponse,
} from '@nix/api-client';
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  Icon,
  Input,
  Select,
  Text,
  Textarea,
  UndoBar,
  useUndo,
} from '@nix/ui';
import { Check, Pencil, Plus } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { newPet, petCatalog } from './catalog';
import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';
import { useInRouteDialog } from '@nix/web-foundation/layout/route-dialog-context';
import { PetAvatar } from './pet-avatar';
import { PetConnectionPanel } from './pet-connection-panel';
import { PetProviderKeys } from './pet-provider-keys';
import { PetDeviceSettings } from './pet-device-settings';
import { PetMemorySection } from './pet-memory-section';
import { memoryModeOf } from './memory-mode';
import { SettingsSection } from '@nix/web-settings/settings/shared/settings-section';

export function PetSettingsSection(): ReactElement {
  const state = usePetSettings();
  const inDialog = useInRouteDialog();
  return (
    <SettingsSection title="Your companion" summary="Set up your companion across workspaces">
      {state.loading ? <Text role="status">Loading your companion…</Text> : null}
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
      {inDialog ? <UndoBar /> : null}
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
  const [message, setMessage] = useState<string | null>(null);
  const [picker, setPicker] = useState<'add' | 'edit' | null>(null);
  const [nameBeforeEdit, setNameBeforeEdit] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const returnToName = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const undo = useUndo();
  const behaviourId = useId();
  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    if (JSON.stringify(draft) !== JSON.stringify(initial.settings)) {
      setDraft(initial.settings);
      setMessage(null);
      setNameBeforeEdit(null);
    }
  }
  const pet = draft.profiles[0] ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial.settings);

  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    (pet === null ? addButton.current : nameButton.current)?.focus();
  }, [pet]);

  useEffect(() => {
    if (nameBeforeEdit !== null) {
      nameInput.current?.focus();
      nameInput.current?.select();
    } else if (returnToName.current) {
      returnToName.current = false;
      nameButton.current?.focus();
    }
  }, [nameBeforeEdit]);

  function change(next: PetSettings): void {
    setDraft(next);
    setMessage(null);
  }
  function updatePet(update: Partial<PetProfile>): void {
    if (pet !== null) change({ ...draft, profiles: [{ ...pet, ...update }] });
  }
  function finishRename(cancel = false): void {
    if (pet === null || nameBeforeEdit === null) return;
    const previousName = nameBeforeEdit;
    setNameBeforeEdit(null);
    if (cancel) {
      updatePet({ name: previousName });
      return;
    }
    const name = pet.name.trim();
    if (pet.name !== name) updatePet({ name });
    if (name !== '' && name !== previousName) {
      undo.push(`Renamed ${previousName || 'pet'} to ${name}`, () => {
        setDraft((current) => ({
          ...current,
          profiles: current.profiles.map((profile) =>
            profile.id === pet.id && profile.name === name
              ? { ...profile, name: previousName }
              : profile,
          ),
        }));
      });
    }
  }
  function add(profile: PetProfile): void {
    if (pet !== null) return;
    restoreFocus.current = true;
    change({ ...draft, activePetId: profile.id, profiles: [profile] });
    undo.push(`Added ${profile.name}`, () => {
      setDraft((cur) =>
        cur.profiles[0]?.id === profile.id
          ? { ...cur, activePetId: null, enabled: false, profiles: [] }
          : cur,
      );
    });
  }
  function remove(): void {
    if (pet === null) return;
    restoreFocus.current = true;
    setNameBeforeEdit(null);
    const gone = pet;
    const wasActive = draft.activePetId;
    const wasEnabled = draft.enabled;
    change({ ...draft, profiles: [], enabled: false, activePetId: null });
    undo.push(`Removed ${gone.name || 'pet'}`, () => {
      setDraft((cur) =>
        cur.profiles.length === 0
          ? { ...cur, profiles: [gone], activePetId: wasActive, enabled: wasEnabled }
          : cur,
      );
    });
  }

  async function saveSettings(): Promise<boolean> {
    // A memory emptied in place is one the owner forgot, not a reason to refuse the whole form.
    const parsed = petSettingsSchema.safeParse({
      ...draft,
      memories: draft.memories?.filter((memory) => memory.text.trim() !== ''),
    });
    if (!parsed.success) {
      setMessage('Check the name and settings of your companion before saving.');
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

  return (
    <form
      className="@container flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSettings();
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Companion settings</legend>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {pet === null ? (
            <Button
              ref={addButton}
              type="button"
              variant="secondary"
              onClick={() => {
                setPicker('add');
              }}
            >
              <Icon icon={Plus} size="sm" />
              Add pet
            </Button>
          ) : (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <Button
                  type="button"
                  variant="subtle"
                  aria-label="Change appearance"
                  title="Change appearance"
                  aria-haspopup="dialog"
                  className="size-14 shrink-0"
                  onClick={() => {
                    setPicker('edit');
                  }}
                >
                  <span aria-hidden>
                    <PetAvatar appearance={pet.appearance} motion="reduced" size="compact" />
                  </span>
                </Button>
                {nameBeforeEdit === null ? (
                  <Button
                    ref={nameButton}
                    type="button"
                    variant="subtle"
                    aria-label={`Rename ${pet.name || 'unnamed pet'}`}
                    title="Rename companion"
                    className="group min-w-0 justify-start"
                    onClick={() => {
                      setNameBeforeEdit(pet.name);
                    }}
                  >
                    <Text as="span" variant="body" className="text-foreground" truncate>
                      {pet.name || 'Unnamed pet'}
                    </Text>
                    <Icon
                      icon={Pencil}
                      size="sm"
                      className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 any-pointer-coarse:opacity-100"
                    />
                  </Button>
                ) : (
                  <Input
                    ref={nameInput}
                    aria-label="Name"
                    required
                    maxLength={80}
                    value={pet.name}
                    onChange={(event) => {
                      updatePet({ name: event.currentTarget.value });
                    }}
                    onBlur={() => {
                      finishRename();
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === 'Escape' || event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        returnToName.current = true;
                        finishRename(event.key === 'Escape');
                      }
                    }}
                  />
                )}
              </div>
              <Button type="button" variant="ghost" onClick={remove}>
                Remove pet
              </Button>
            </>
          )}
        </div>
        {pet ? (
          <>
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
          </>
        ) : null}
        <section aria-labelledby={behaviourId} className="flex min-w-0 flex-col gap-4">
          <Text variant="h5" as="h3" id={behaviourId}>
            Behaviour
          </Text>
          {pet === null ? null : (
            <Checkbox
              label="Apply changes without asking"
              checked={pet.applyWithoutAsking}
              onChange={(event) => {
                updatePet({ applyWithoutAsking: event.currentTarget.checked });
              }}
            />
          )}
          <Checkbox
            label="Show companion in my workspaces"
            checked={draft.enabled}
            disabled={pet === null}
            onChange={(event) => {
              change({
                ...draft,
                enabled: event.currentTarget.checked,
                activePetId: pet?.id ?? null,
              });
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
          {draft.enabled ? <PetDeviceSettings inlineWriting={draft.inlineWriting} /> : null}
        </section>
        <PetMemorySection
          memories={draft.memories ?? []}
          mode={memoryModeOf(draft)}
          onChange={(memories, memoryMode) => {
            change({ ...draft, memories, memoryMode });
          }}
        />
      </fieldset>
      {picker === null ? null : (
        <PetAppearancePicker
          initial={picker === 'edit' ? (pet?.appearance ?? 'owl') : 'owl'}
          adding={picker === 'add'}
          onClose={() => {
            setPicker(null);
          }}
          onChoose={(appearance) => {
            setPicker(null);
            if (picker === 'add') {
              const profile = newPet(appearance);
              add(profile);
            } else if (pet !== null && pet.appearance !== appearance) {
              updatePet({ appearance });
              undo.push(`Changed ${pet.name || 'pet'}’s appearance`, () => {
                setDraft((current) => ({
                  ...current,
                  profiles: current.profiles.map((profile) =>
                    profile.id === pet.id && profile.appearance === appearance
                      ? { ...profile, appearance: pet.appearance }
                      : profile,
                  ),
                }));
              });
            }
          }}
        />
      )}
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

function PetAppearancePicker({
  initial,
  adding,
  onClose,
  onChoose,
}: {
  readonly initial: PetProfile['appearance'];
  readonly adding: boolean;
  readonly onClose: () => void;
  readonly onChoose: (appearance: PetProfile['appearance']) => void;
}): ReactElement {
  const [appearance, setAppearance] = useState(initial);
  const radioName = useId();
  const selected = petCatalog.find((entry) => entry.appearance === appearance) ?? petCatalog[0];
  return (
    <Dialog
      open
      title={adding ? 'Choose a pet' : 'Change appearance'}
      onClose={onClose}
      className="sm:max-w-3xl"
      actions={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              onChoose(appearance);
            }}
          >
            {adding ? `Add ${selected.name}` : 'Use this appearance'}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <fieldset className="grid min-w-0 grid-cols-3 content-start gap-2 lg:grid-cols-4">
          <legend className="sr-only">Available pets</legend>
          {petCatalog.map((entry, index) => {
            // gallery.webp holds one idle frame per catalog entry, in catalog order.
            const portraitStyle = {
              backgroundImage: 'url(/pets/gallery.webp)',
              backgroundSize: `${String(petCatalog.length * 100)}% 100%`,
              backgroundPosition: `${String((index * 100) / (petCatalog.length - 1))}% 0`,
            };
            return (
              <label
                key={entry.appearance}
                className="relative flex min-w-0 cursor-pointer flex-col items-center gap-1 rounded-md border border-divider bg-surface p-1 text-center hover:border-accent has-checked:border-accent has-checked:bg-accent/10 has-focus-visible:outline-2 has-focus-visible:outline-accent"
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={radioName}
                  checked={appearance === entry.appearance}
                  onChange={() => {
                    setAppearance(entry.appearance);
                  }}
                />
                <span aria-hidden className="size-14 shrink-0 bg-no-repeat" style={portraitStyle} />
                <Text as="span" variant="caption" className="wrap-anywhere">
                  {entry.name}
                </Text>
                {appearance === entry.appearance ? (
                  <span className="absolute right-1 top-1 text-accent-text" aria-hidden>
                    <Icon icon={Check} size="sm" />
                  </span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
        <div className="order-first flex flex-col gap-2 rounded-md border border-divider bg-surface p-3 sm:order-none">
          <div className="flex justify-center">
            <PetAvatar appearance={appearance} size="preview" label={`${selected.name} preview`} />
          </div>
          <Text as="h3" variant="h4">
            {selected.name}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {selected.description}
          </Text>
        </div>
      </div>
    </Dialog>
  );
}

function PetInstructions({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement {
  return (
    <Field
      label="Instructions (optional)"
      hint="Tell your companion how you like to work. Instructions never grant extra access."
    >
      {(control) => (
        <Textarea
          {...control}
          rows={3}
          maxLength={2000}
          value={value}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
        />
      )}
    </Field>
  );
}
