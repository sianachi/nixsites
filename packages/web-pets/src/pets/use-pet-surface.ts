import { useSyncExternalStore } from 'react';
import { readPetSurface, type PetSurface } from '@nix/web-foundation/lib/device-preferences';

function subscribe(onChange: () => void): () => void {
  // `nix-pet-device-changed` covers this tab's own writes; `storage` covers another tab's.
  window.addEventListener('nix-pet-device-changed', onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener('nix-pet-device-changed', onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The device's chat-surface preference, kept current without a reload. */
export function usePetSurface(): PetSurface {
  return useSyncExternalStore(subscribe, readPetSurface, readPetSurface);
}
