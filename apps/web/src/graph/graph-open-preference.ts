import { z } from 'zod';
import { create } from 'zustand';

import { browserStorage } from '@nix/web-foundation/lib/browser-storage';
import { registerSyncedSetting, settingChanged } from '@nix/web-foundation/lib/ui-settings-sync';

/**
 * How a node opened from the graph is presented: synced to the account as `graph.openMode`. The
 * graph is not a saved view, so this stands in for a view's `open`; the default is the dialog the
 * graph has always used. `none` is a view-only mode and is not offered here.
 */
export const GraphOpenModeSchema = z.enum(['page', 'dialog', 'tab']);
export type GraphOpenMode = z.infer<typeof GraphOpenModeSchema>;

export const GRAPH_OPEN_MODE_LABELS: Readonly<Record<GraphOpenMode, string>> = {
  page: 'Page',
  dialog: 'Dialog',
  tab: 'New tab',
};

/**
 * The account may still hold `beside` (the server accepts it), but the graph route has no pane to
 * open beside, so it would only ever act as a dialog; read it as one.
 */
const StoredGraphOpenModeSchema = z
  .enum(['page', 'dialog', 'beside', 'tab'])
  .transform((mode): GraphOpenMode => (mode === 'beside' ? 'dialog' : mode));

export const DEFAULT_GRAPH_OPEN_MODE: GraphOpenMode = 'dialog';
const KEY = 'nix.graph-open-mode';

function read(): GraphOpenMode {
  try {
    const parsed = StoredGraphOpenModeSchema.safeParse(browserStorage()?.getItem(KEY));
    return parsed.success ? parsed.data : DEFAULT_GRAPH_OPEN_MODE;
  } catch {
    return DEFAULT_GRAPH_OPEN_MODE;
  }
}

export const useGraphOpenPreference = create<{
  readonly mode: GraphOpenMode;
  readonly setMode: (mode: GraphOpenMode | 'beside') => void;
}>((set) => ({
  mode: read(),
  setMode: (requested) => {
    const mode = StoredGraphOpenModeSchema.parse(requested);
    try {
      if (mode === DEFAULT_GRAPH_OPEN_MODE) browserStorage()?.removeItem(KEY);
      else browserStorage()?.setItem(KEY, mode);
    } catch {
      // Blocked storage still lets the choice hold for this session.
    }
    set({ mode });
    settingChanged('graph.openMode', mode);
  },
}));

registerSyncedSetting('graph.openMode', {
  get: () => useGraphOpenPreference.getState().mode,
  set: (mode) => {
    useGraphOpenPreference.getState().setMode(mode);
  },
  defaultValue: DEFAULT_GRAPH_OPEN_MODE,
});
