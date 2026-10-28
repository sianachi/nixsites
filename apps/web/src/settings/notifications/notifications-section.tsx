import { type PreferencesInput, type PrincipalPreferencesResponse } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text, cn } from '@nix/ui';
import { useEffect, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  currentPushSubscription,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  pushSupported,
  type PushUnavailableReason,
} from '@nix/web-platform/pwa/push-subscription';
import { SettingsSection } from '../shared/settings-section';
import { preferencesInputFrom } from '../shared/preference-defaults';
import { useMutedContainerTitles } from './use-muted-container-titles';
import { useNotificationPreferences } from './use-notification-preferences';

export function NotificationsSection(): ReactElement {
  const state = useNotificationPreferences();
  return (
    <SettingsSection title="Notifications" summary="Reminders, quiet hours and push alerts">
      {state.loading ? <Text role="status">Loading your notification settings…</Text> : null}
      {state.error !== null ? (
        <Text role="alert" variant="note">
          {state.error}
        </Text>
      ) : null}
      {state.saved !== null ? (
        <NotificationPreferencesForm
          initial={state.saved}
          saving={state.saving || state.loading}
          onSave={state.save}
        />
      ) : null}
      <PushDeviceSettings />
    </SettingsSection>
  );
}

interface FormProps {
  readonly initial: PrincipalPreferencesResponse;
  readonly saving: boolean;
  readonly onSave: (value: PreferencesInput) => Promise<boolean>;
}

function NotificationPreferencesForm({ initial, saving, onSave }: FormProps): ReactElement {
  const [previousInitial, setPreviousInitial] = useState(initial);
  const [draft, setDraft] = useState(() => preferencesInputFrom(initial));
  const [message, setMessage] = useState<string | null>(null);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(
    initial.quietStart !== null || initial.quietEnd !== null,
  );

  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    // Only actually reset the draft (and the "saved" message with it) when the fresh document's
    // content differs from what is already on screen. A save's own response is a new object with
    // the same values the form just submitted, and resetting on identity alone would wipe the
    // "Notification settings saved." message the submit handler sets the moment this same
    // response lands - see `pets/pet-settings-section.tsx`'s `PetSettingsEditor` for the pattern.
    const freshDraft = preferencesInputFrom(initial);
    if (JSON.stringify(freshDraft) !== JSON.stringify(draft)) {
      setDraft(freshDraft);
      setQuietHoursEnabled(initial.quietStart !== null || initial.quietEnd !== null);
      setMessage(null);
    }
  }

  const { containers: mutedContainers } = useMutedContainerTitles(draft.mutedContainerIds);

  function change(next: PreferencesInput): void {
    setDraft(next);
    setMessage(null);
  }

  function removeMutedContainer(itemId: string): void {
    const next = {
      ...draft,
      mutedContainerIds: draft.mutedContainerIds.filter((id) => id !== itemId),
    };
    change(next);
    void onSave(next).then((ok) => {
      if (ok) setMessage('Notification settings saved.');
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        const toSave: PreferencesInput = quietHoursEnabled
          ? draft
          : { ...draft, quietStart: null, quietEnd: null };
        void onSave(toSave).then((ok) => {
          if (ok) {
            setDraft(toSave);
            setMessage('Notification settings saved.');
          }
        });
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Reminders and quiet hours</legend>

        <Field label="Time zone" hint="Times reminders and quiet hours" className="max-w-sm">
          {(control) => (
            <Input
              {...control}
              value={draft.timeZone}
              onChange={(event) => {
                change({ ...draft, timeZone: event.currentTarget.value });
              }}
            />
          )}
        </Field>

        <Field label="Due-task reminder time" className="max-w-xs">
          {(control) => (
            <Input
              {...control}
              type="time"
              value={draft.dueReminderTime}
              onChange={(event) => {
                change({ ...draft, dueReminderTime: event.currentTarget.value });
              }}
            />
          )}
        </Field>

        <Text variant="h5" as="h3">
          Reminders
        </Text>
        <Checkbox
          label="Remind me about due tasks"
          checked={draft.dueReminders}
          onChange={(event) => {
            change({ ...draft, dueReminders: event.currentTarget.checked });
          }}
        />
        <Checkbox
          label="Remind me about habits"
          checked={draft.habitReminders}
          onChange={(event) => {
            change({ ...draft, habitReminders: event.currentTarget.checked });
          }}
        />
        <Checkbox
          label="Quiet hours"
          checked={quietHoursEnabled}
          onChange={(event) => {
            setQuietHoursEnabled(event.currentTarget.checked);
            setMessage(null);
          }}
        />
        {quietHoursEnabled ? (
          <div className="flex flex-wrap gap-4">
            <Field label="Starts" className="max-w-xs">
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  value={draft.quietStart ?? ''}
                  onChange={(event) => {
                    change({ ...draft, quietStart: event.currentTarget.value || null });
                  }}
                />
              )}
            </Field>
            <Field label="Ends" className="max-w-xs">
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  value={draft.quietEnd ?? ''}
                  onChange={(event) => {
                    change({ ...draft, quietEnd: event.currentTarget.value || null });
                  }}
                />
              )}
            </Field>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Text variant="h5" as="h3">
            Muted containers
          </Text>
          {mutedContainers.length === 0 ? (
            <Text variant="note" tone="muted">
              Nothing is muted; mute a folder or board from its menu
            </Text>
          ) : (
            <ul className="flex flex-col gap-1">
              {mutedContainers.map((container) => (
                <li key={container.id} className="flex items-center justify-between gap-3">
                  <Text variant="bodySmall" className="min-w-0 truncate">
                    {container.title ?? 'Unknown item'}
                  </Text>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      removeMutedContainer(container.id);
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {message !== null ? (
          <Text role="status" variant="note">
            {message}
          </Text>
        ) : null}
      </fieldset>
    </form>
  );
}

type PushState =
  | { readonly status: 'checking' }
  | { readonly status: PushUnavailableReason }
  | { readonly status: 'enabled' }
  | { readonly status: 'disabled' };

const pushUnavailableCopy: Record<PushUnavailableReason, string> = {
  unsupported: 'This browser does not support push notifications.',
  unavailable: 'Push has not been configured on this server. The inbox still works.',
  denied:
    'Notifications are blocked for this site. Allow them in your browser settings to enable push.',
  error: 'Push could not be set up on this device. Try again.',
};

function PushDeviceSettings(): ReactElement {
  const client = useApiClient();
  const [state, setState] = useState<PushState>({ status: 'checking' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (!pushSupported()) {
        setState({ status: 'unsupported' });
        return;
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
        setState({ status: 'denied' });
        return;
      }
      void currentPushSubscription().then((subscription) => {
        if (cancelled) return;
        setState({ status: subscription !== null ? 'enabled' : 'disabled' });
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable(): Promise<void> {
    setBusy(true);
    const result = await enablePushOnThisDevice(client);
    setState(result.ok ? { status: 'enabled' } : { status: result.reason ?? 'error' });
    setBusy(false);
  }

  async function disable(): Promise<void> {
    setBusy(true);
    const ok = await disablePushOnThisDevice(client);
    setState({ status: ok ? 'disabled' : 'error' });
    setBusy(false);
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-t border-divider pt-4', // spacing-role-exempt: a top-border section divider under a form, not the bordered-panel role the p-3 convention belongs to - only its top edge pads.
      )}
    >
      <Text variant="h5" as="h3">
        Push notifications on this device
      </Text>
      {state.status === 'checking' ? <Text variant="note">Checking…</Text> : null}
      {state.status === 'enabled' ? (
        <>
          <Text variant="note" tone="muted">
            Alerts reach this device even when Nix is closed
          </Text>
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void disable();
              }}
            >
              {busy ? 'Turning off…' : 'Turn off on this device'}
            </Button>
          </div>
        </>
      ) : null}
      {state.status === 'disabled' ? (
        <div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void enable();
            }}
          >
            {busy ? 'Turning on…' : 'Turn on for this device'}
          </Button>
        </div>
      ) : null}
      {state.status !== 'checking' && state.status !== 'enabled' && state.status !== 'disabled' ? (
        state.status === 'error' ? (
          <Text variant="note" role="alert">
            {pushUnavailableCopy[state.status]}
          </Text>
        ) : (
          <Text variant="note">{pushUnavailableCopy[state.status]}</Text>
        )
      ) : null}
    </div>
  );
}
