import type { MenuEntry } from '@nix/ui';
import { Zap } from 'lucide-react';
import { useNavigate } from 'react-router';

import { automationsHref } from './automation-url';

/**
 * "Automate…" on an item's menu: opens a new automation whose scope is that item, so the rule
 * watches what is inside it and may create items there. Everything else is chosen in the editor.
 */
export function useAutomateEntry(
  workspaceId: string | null,
): ((itemId: string) => MenuEntry) | null {
  const navigate = useNavigate();
  if (workspaceId === null) return null;
  return (itemId) => ({
    kind: 'action',
    label: 'Automate…',
    icon: Zap,
    onSelect: () => {
      void navigate(automationsHref(workspaceId, { kind: 'new', scopeItemId: itemId }));
    },
  });
}
