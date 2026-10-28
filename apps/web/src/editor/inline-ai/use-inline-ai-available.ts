import { usePetSettings } from '@nix/web-platform/api/use-pet-settings';

/**
 * Whether the writing assistance in the note editor is on offer.
 *
 * It is on only when pets are enabled and the person has switched inline writing on.
 */
export function useInlineAiAvailable(): boolean {
  const { saved } = usePetSettings();
  // Read defensively: an optional assistant must never take the note editor with it, whatever
  // shape a half-loaded or older response has.
  const settings = saved?.settings;
  return settings?.enabled === true && settings.inlineWriting;
}
