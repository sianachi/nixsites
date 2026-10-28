import { create } from 'zustand';

import { writeStored } from '../../editor/stored-setting';
import { browserStorage } from '../../lib/browser-storage';

/**
 * General browser preferences.
 *
 * On by default: only the 'off' preference is stored in localStorage so that
 * defaults stay forward-compatible.
 */
const FOOTER_VISIBLE_KEY = 'nix.footer-visible';

export function readFooterVisible(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(FOOTER_VISIBLE_KEY) !== 'off';
  } catch {
    return true;
  }
}

const HOMEBASE_LAYOUT_KEY = 'nix.homebase-layout';

/** Homebase's two arrangements: one centred column, or actions beside the recent items. */
export type HomebaseLayout = 'page' | 'desk';

export function readHomebaseLayout(storage: Storage | undefined): HomebaseLayout {
  try {
    return storage?.getItem(HOMEBASE_LAYOUT_KEY) === 'desk' ? 'desk' : 'page';
  } catch {
    return 'page';
  }
}

export interface GeneralPreferencesState {
  readonly footerVisible: boolean;
  readonly setFooterVisible: (visible: boolean) => void;
  readonly homebaseLayout: HomebaseLayout;
  readonly setHomebaseLayout: (layout: HomebaseLayout) => void;
}

export const useGeneralPreferences = create<GeneralPreferencesState>((set) => ({
  footerVisible: readFooterVisible(browserStorage()),
  setFooterVisible: (visible: boolean) => {
    writeStored(FOOTER_VISIBLE_KEY, visible ? null : 'off');
    set({ footerVisible: visible });
  },
  homebaseLayout: readHomebaseLayout(browserStorage()),
  setHomebaseLayout: (layout: HomebaseLayout) => {
    writeStored(HOMEBASE_LAYOUT_KEY, layout === 'page' ? null : layout);
    set({ homebaseLayout: layout });
  },
}));
