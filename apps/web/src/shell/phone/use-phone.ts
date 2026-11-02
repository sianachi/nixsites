import { useMediaQuery } from '@nix/web-foundation/layout/viewport';
import { WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT } from '@nix/web-foundation/layout/regions';

/** Below `sm`: the Obsidian-style phone chrome. Tablets and desktop keep today's shell. */
export function usePhone(): boolean {
  return !useMediaQuery(WIDE_ENOUGH_FOR_NON_PHONE_LAYOUT);
}
