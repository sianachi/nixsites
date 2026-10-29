import type { PetSettings } from '@nix/api-client';

/** How the pet may save memories; settings saved before the choice existed read as `ask`. */
export type PetMemoryMode = NonNullable<PetSettings['memoryMode']>;

export function memoryModeOf(settings: PetSettings): PetMemoryMode {
  return settings.memoryMode ?? 'ask';
}
