import { type ReactElement } from 'react';

import { useCapabilities } from '../../session/capabilities-context';
import { usePublishingPreference } from '../publishing/publishing-preference';
import { PreferenceToggle } from '../shared/preference-toggle';
import { SettingsSection } from '../shared/settings-section';

export function PreferencesSection(): ReactElement {
  const sites = useCapabilities().sites;
  const publishing = usePublishingPreference((state) => state.enabled);
  const setPublishing = usePublishingPreference((state) => state.setEnabled);

  return (
    <SettingsSection title="General">
      {sites ? (
        <PreferenceToggle
          label="Show publishing on pages"
          checked={publishing}
          onChange={setPublishing}
          description="Adds Publish as a site to the page menu and the item panel"
          unsaved={null}
        />
      ) : null}
    </SettingsSection>
  );
}
