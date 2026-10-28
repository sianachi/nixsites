import { Button, Icon } from '@nix/ui';
import { Minimize2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { setZenMode } from '@nix/web-foundation/lib/zen-mode';

/**
 * The way out of Zen: small, quiet, and always there for whoever goes looking.
 *
 * Fixed to the top-right of the window; it is the first thing Tab reaches while Zen is on.
 * The shell mounts it before anything else, in place of the skip link. `z-20` clears pane
 * content and stays under the dialogs' `z-30`, so a modal that is open is not left with a live
 * control above it.
 */
export function ZenExit(): ReactNode {
  return (
    <Button
      variant="icon"
      aria-label="Exit Zen mode"
      title="Exit Zen mode"
      onClick={() => {
        setZenMode(false);
      }}
      // design-token-exempt: inset from the window corner, clear of the device safe area.
      className="fixed right-[calc(env(safe-area-inset-right)+var(--spacing)*3)] top-[calc(env(safe-area-inset-top)+var(--spacing)*2)] z-20 min-h-(--control-lg) min-w-(--control-lg) bg-background text-muted opacity-75 hover:opacity-100 focus-visible:opacity-100"
    >
      <Icon icon={Minimize2} size="sm" />
    </Button>
  );
}
