import { type ReactElement } from 'react';

import { useIconStripPreference } from '@nix/web-foundation/lib/icon-strip-preference';
import { useStatusBarPreference } from '@nix/web-foundation/lib/status-bar-preference';
import { useCapabilities } from '@nix/web-platform/session/capabilities-context';
import { usePublishingPreference } from '../publishing/publishing-preference';
import { PreferenceToggle } from '../shared/preference-toggle';
import { SettingsSection } from '../shared/settings-section';

export function PreferencesSection(): ReactElement {
  const sites = useCapabilities().sites;
  const publishing = usePublishingPreference((state) => state.enabled);
  const setPublishing = usePublishingPreference((state) => state.setEnabled);
  const statusBar = useStatusBarPreference((state) => state.enabled);
  const setStatusBar = useStatusBarPreference((state) => state.setEnabled);
  const iconStrip = useIconStripPreference((state) => state.enabled);
  const setIconStrip = useIconStripPreference((state) => state.setEnabled);

  return (
    <>
      <SettingsSection title="Appearance">
        <PreferenceToggle
          label="Show icon strip"
          checked={iconStrip}
          onChange={setIconStrip}
          description="The strip of destinations down the left on a wide screen"
          unsaved={null}
        />
        <PreferenceToggle
          label="Show status bar"
          checked={statusBar}
          onChange={setStatusBar}
          description="Backlinks, word or item count and sync state, along the bottom on a wide screen"
          unsaved={null}
        />
      </SettingsSection>
      {sites ? (
        <SettingsSection title="General">
          <PreferenceToggle
            label="Show publishing on pages"
            checked={publishing}
            onChange={setPublishing}
            description="Adds Publish as a site to the page menu and the item panel"
            unsaved={null}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}
