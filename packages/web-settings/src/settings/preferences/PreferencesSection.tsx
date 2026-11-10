import { type ReactElement } from 'react';
import { Text } from '@nix/ui';

import { useCapabilities } from '@nix/web-platform/session/capabilities-context';
import { usePublishingPreference } from '../publishing/publishing-preference';
import { PreferenceToggle } from '../shared/preference-toggle';
import { ScopeNote } from '../shared/saved-mark';
import { SettingsSection } from '../shared/settings-section';

export function PreferencesSection(): ReactElement {
  const sites = useCapabilities().sites;
  const publishing = usePublishingPreference((state) => state.enabled);
  const setPublishing = usePublishingPreference((state) => state.setEnabled);

  return (
    <>
      <SettingsSection title="Appearance">
        <Text as="p" variant="bodySmall" tone="muted">
          To change your layout, open Preferences in the account menu.
        </Text>
      </SettingsSection>
      {sites ? (
        <SettingsSection
          title="General"
          scope={<ScopeNote>Saved to your account, all devices</ScopeNote>}
        >
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
