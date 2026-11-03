import { useNarrowViewport } from '@nix/web-foundation/layout/viewport';

/** The Obsidian-style phone chrome: phones, and portrait tablets (which add a tab strip). Desktop and landscape tablets keep the wide shell. */
export function usePhone(): boolean {
  return useNarrowViewport();
}
