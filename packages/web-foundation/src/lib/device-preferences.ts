import type { PetProfile } from '@nix/api-client';

import { writeStored } from './stored-setting';
import { browserStorage } from './browser-storage';

/** One stored value, or null when absent or storage is blocked. */
function readLocal(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Where the chat opens: a floating panel, a right drawer, or its own page. A device preference because
 * the right answer depends on the screen in front of the owner, not on the pet. */
export type PetSurface = 'floating' | 'drawer' | 'page-on-phones' | 'page' | 'both';

export const PET_SURFACE_DEFAULT: PetSurface = 'drawer';

export const PET_SURFACE_OPTIONS: readonly {
  readonly value: PetSurface;
  readonly label: string;
}[] = [
  { value: 'floating', label: 'Floating panel everywhere' },
  { value: 'drawer', label: 'Right-side drawer' },
  { value: 'page-on-phones', label: 'Its own page on phones, floating elsewhere' },
  { value: 'page', label: 'Its own page everywhere, with no floating pet' },
  { value: 'both', label: 'Both: floating panel, and a page in the navigation' },
];

export interface PetPosition {
  x: number;
  y: number;
}

export function readPetPosition(): PetPosition | null {
  try {
    const raw = readLocal('nix.pet.position');
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'x' in parsed &&
      'y' in parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    )
      return { x: parsed.x, y: parsed.y };
  } catch {
    /* Fall back to the edge placement when storage is unavailable or malformed. */
  }
  return null;
}

export function writePetPosition(position: PetPosition): void {
  writeStored('nix.pet.position', JSON.stringify(position));
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

// The ".chat" suffix is kept from when each conversation mode stored its own choice, so a
// model chosen before Design mode was retired still applies.
function conversationModelKey(
  workspaceId: string,
  petId: string,
  provider: PetProfile['provider'],
): string {
  return `nix.pet.model.${workspaceId}.${petId}.${provider === 'chatgpt' ? 'chat' : provider}`;
}

export function readConversationModel(
  workspaceId: string,
  petId: string,
  provider: PetProfile['provider'],
): string {
  try {
    const model =
      readLocal(conversationModelKey(workspaceId, petId, provider)) ??
      (provider === 'chatgpt'
        ? sessionStorage.getItem(`nix.pet.model.${workspaceId}.${petId}`)
        : null) ??
      '';
    return model.length <= 160 ? model : '';
  } catch {
    return '';
  }
}

export function writeConversationModel(
  workspaceId: string,
  petId: string,
  provider: PetProfile['provider'],
  model: string,
): void {
  writeStored(conversationModelKey(workspaceId, petId, provider), model);
}

type DevicePreferenceKey = 'placement' | 'surface' | 'inlineContext';

export function readDevicePreference(key: DevicePreferenceKey): string {
  return readLocal(`nix.pet.${key}`) ?? '';
}

export function writeDevicePreference(key: DevicePreferenceKey, value: string): void {
  writeStored(`nix.pet.${key}`, value);
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

/** The stored surface, or the default when nothing valid is stored - a value written by a
 * different build must not leave the chat with nowhere to open. */
export function readPetSurface(): PetSurface {
  const stored = readDevicePreference('surface');
  return (
    PET_SURFACE_OPTIONS.find((option) => option.value === stored)?.value ?? PET_SURFACE_DEFAULT
  );
}

/** Whether reads run without an approval click.
 * Defaults on (ADR-0050 amendment 1). Reads remain Core-authorised and scoped to the workspace,
 * at most 20 per turn and 16000 characters each. This legacy preference controls per-read
 * prompts; Core's destination-bound sharing consent is required separately. Device-wide,
 * like `placement` above. */
export function readReadWithoutAsking(): boolean {
  const raw = readLocal('nix.pet.readWithoutAsking');
  return raw === null ? true : raw === 'true';
}

export function writeReadWithoutAsking(value: boolean): void {
  writeStored('nix.pet.readWithoutAsking', String(value));
  window.dispatchEvent(new Event('nix-pet-device-changed'));
}

function workspaceAccessKey(workspaceId: string, petId: string): string {
  return `nix.pet.workspaceAccess.${workspaceId}.${petId}`;
}

/** Whether workspace context is offered for this pet on this device. New workspaces default
 * to on; an explicit off choice is retained. This UI preference does not replace Core access
 * checks or the provider-sharing decision required by whole-plan conversations. */
export function readWorkspaceAccess(workspaceId: string, petId: string): boolean {
  return readLocal(workspaceAccessKey(workspaceId, petId)) !== 'false';
}

export function writeWorkspaceAccess(workspaceId: string, petId: string, value: boolean): void {
  writeStored(workspaceAccessKey(workspaceId, petId), String(value));
}
