import { type PreferencesInput, type PrincipalPreferencesResponse } from '@nix/api-client';
import { Button, Checkbox, Field, Input, Text, cn, useUndo } from '@nix/ui';
import { useEffect, useRef, useState, type ReactElement } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import {
  currentPushSubscription,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  pushSupported,
  type PushUnavailableReason,
} from '@nix/web-platform/pwa/push-subscription';
import { ScopeNote } from '../shared/saved-mark';
import { SettingsSection } from '../shared/settings-section';
import { SaveBar, revertChanged, useLeaveGuard } from '../shared/unsaved';
import { preferencesInputFrom } from '../shared/preference-defaults';
import { useMutedContainerTitles } from './use-muted-container-titles';
import { useNotificationPreferences } from './use-notification-preferences';

export function NotificationsSection(): ReactElement {
  const state = useNotificationPreferences();
  return (
    <SettingsSection
      title="Notifications"
      summary="Reminders, quiet hours and push alerts"
      scope={
        <ScopeNote>
          Saved to your account, all devices. Press Save to apply the reminder settings; push is per
          device.
        </ScopeNote>
      }
    >
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

/** The zone's current time, or null when the name is not a real time zone. */
function timeInZone(timeZone: string, now: Date): string | null {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, timeStyle: 'short' }).format(now);
  } catch {
    return null;
  }
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
  const undo = useUndo();
  // Undo runs later, so it reads the newest saved document and save function from these.
  const latest = useRef({ initial, onSave });
  useEffect(() => {
    latest.current = { initial, onSave };
  });
  const effective: PreferencesInput = quietHoursEnabled
    ? draft
    : { ...draft, quietStart: null, quietEnd: null };
  const dirty = JSON.stringify(effective) !== JSON.stringify(preferencesInputFrom(initial));
  useLeaveGuard(dirty);
  const now = new Date();
  const zoneTime = timeInZone(draft.timeZone, now);

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

  function removeMutedContainer(itemId: string, title: string): void {
    const index = draft.mutedContainerIds.indexOf(itemId);
    const next = {
      ...draft,
      mutedContainerIds: draft.mutedContainerIds.filter((id) => id !== itemId),
    };
    change(next);
    void onSave(next).then((ok) => {
      if (!ok) return;
      setMessage(`“${title}” unmuted, saved to your account.`);
      undo.push(`Unmuted “${title}”`, async () => {
        const current = preferencesInputFrom(latest.current.initial);
        if (current.mutedContainerIds.includes(itemId)) return;
        const ids = [...current.mutedContainerIds];
        ids.splice(Math.min(index, ids.length), 0, itemId);
        const ok = await latest.current.onSave({ ...current, mutedContainerIds: ids });
        if (ok) setDraft((d) => ({ ...d, mutedContainerIds: ids }));
      });
    });
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || zoneTime === null) return;
        const before = preferencesInputFrom(initial);
        const toSave = effective;
        void onSave(toSave).then((ok) => {
          if (!ok) return;
          setDraft(toSave);
          setMessage('Notification settings saved to your account.');
          undo.push('Saved notification settings', async () => {
            const reverted = revertChanged(
              before,
              toSave,
              preferencesInputFrom(latest.current.initial),
            );
            if (await latest.current.onSave(reverted)) {
              setDraft(reverted);
              setQuietHoursEnabled(reverted.quietStart !== null || reverted.quietEnd !== null);
            }
          });
        });
      }}
    >
      <fieldset disabled={saving} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Reminders and quiet hours</legend>

        <Field
          label="Time zone"
          {...(zoneTime === null
            ? {}
            : { hint: `Times reminders and quiet hours. It is ${zoneTime} there now.` })}
          error={
            zoneTime === null ? 'Not a time zone Nix knows. Try a name like Europe/London.' : null
          }
          className="max-w-sm"
        >
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
                    variant="subtle"
                    onClick={() => {
                      removeMutedContainer(container.id, container.title ?? 'Unknown item');
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <SaveBar
          dirty={dirty}
          saving={saving}
          disabled={zoneTime === null}
          saved={message}
          onDiscard={() => {
            const was = { draft, quietHoursEnabled };
            setDraft(preferencesInputFrom(initial));
            setQuietHoursEnabled(initial.quietStart !== null || initial.quietEnd !== null);
            setMessage('Unsaved changes discarded.');
            undo.push('Discarded unsaved notification changes', () => {
              setDraft(was.draft);
              setQuietHoursEnabled(was.quietHoursEnabled);
            });
          }}
        />
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
  const undo = useUndo();

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

  async function enable(record = true): Promise<void> {
    setBusy(true);
    const result = await enablePushOnThisDevice(client);
    setState(result.ok ? { status: 'enabled' } : { status: result.reason ?? 'error' });
    setBusy(false);
    if (result.ok && record) {
      undo.push('Turned on push for this device', () => disable(false));
    }
  }

  async function disable(record = true): Promise<void> {
    setBusy(true);
    const ok = await disablePushOnThisDevice(client);
    setState({ status: ok ? 'disabled' : 'error' });
    setBusy(false);
    if (ok && record) undo.push('Turned off push for this device', () => enable(false));
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
      <ScopeNote>This device only</ScopeNote>
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
