import { type DailyNoteSettings } from '@nix/api-client';
import { Button, Field, Select, Text, Textarea, cn } from '@nix/ui';
import { useState, type ReactElement } from 'react';

import {
  readOpenDailyOnLaunch,
  writeOpenDailyOnLaunch,
} from '@nix/web-foundation/lib/daily-note-device-preferences';
import { PreferenceToggle } from '../shared/preference-toggle';
import { SettingsSection } from '../shared/settings-section';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useDailyNoteSettings } from './use-daily-note-settings';

const FOLDER_OPTIONS: readonly { value: DailyNoteSettings['folders']; label: string }[] = [
  { value: 'flat', label: 'All in one folder' },
  { value: 'by-year', label: 'A folder per year' },
  { value: 'by-month', label: 'A folder per year and month' },
];

const ROLLOVER_LABELS = ['Midnight', '1am', '2am', '3am', '4am', '5am', '6am'] as const;

/** Today's date written the way each title format would write it, so the choice shows its result. */
function titleExamples(now: Date): Record<DailyNoteSettings['titleFormat'], string> {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(now);
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long' }).format(now);
  const long = `${String(now.getDate())} ${month} ${String(now.getFullYear())}`;
  return {
    iso: `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    long,
    'weekday-long': `${weekday} ${long}`,
  };
}

export function DailyNotesSection(): ReactElement {
  const { workspaceId, workspace } = useWorkspace();
  const state = useDailyNoteSettings(workspaceId);
  // `canRename` is the server's "owner or tenant admin" flag, the same rule that gates saving
  // these settings, so it tells us up front what a save would answer.
  const canManage = workspace.canRename && !state.forbidden;

  return (
    <SettingsSection
      title="Daily notes"
      summary="One note per day, created the first time you open it"
    >
      {state.loading ? <Text role="status">Loading daily note settings…</Text> : null}
      {state.error !== null ? (
        <Text role="alert" variant="note">
          {state.error}
        </Text>
      ) : null}
      {state.saved !== null ? (
        <DailyNotesForm
          // A different workspace is a different document; remount so the draft cannot carry over.
          key={workspaceId}
          initial={state.saved}
          saving={state.saving || state.loading}
          canManage={canManage}
          onSave={state.save}
        />
      ) : null}
      <DeviceSettings />
    </SettingsSection>
  );
}

interface FormProps {
  readonly initial: DailyNoteSettings;
  readonly saving: boolean;
  readonly canManage: boolean;
  readonly onSave: (value: DailyNoteSettings) => Promise<boolean>;
}

function DailyNotesForm({ initial, saving, canManage, onSave }: FormProps): ReactElement {
  const [previousInitial, setPreviousInitial] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [message, setMessage] = useState<string | null>(null);
  const examples = titleExamples(new Date());

  if (initial !== previousInitial) {
    setPreviousInitial(initial);
    // Reset only when the fresh document's content differs from the draft: a save's own response
    // is a new object with the values just submitted, and resetting on identity alone would wipe
    // the confirmation the submit handler sets as that response lands (see
    // `notifications-section.tsx`).
    if (JSON.stringify(initial) !== JSON.stringify(draft)) {
      setDraft(initial);
      setMessage(null);
    }
  }

  const unchanged = JSON.stringify(draft) === JSON.stringify(initial);

  function change(next: DailyNoteSettings): void {
    setDraft(next);
    setMessage(null);
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(draft).then((ok) => {
          if (ok) setMessage('Daily note settings saved.');
        });
      }}
    >
      {canManage ? null : (
        <Text variant="note" role="status">
          Only a workspace owner or administrator can change these settings.
        </Text>
      )}
      <fieldset disabled={saving || !canManage} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Daily notes in this workspace</legend>

        <PreferenceToggle
          label="Use daily notes in this workspace"
          checked={draft.enabled}
          onChange={(enabled) => {
            change({ ...draft, enabled });
          }}
          description="Everyone who can edit a shared workspace shares the day’s note"
          unsaved={null}
          more="Shared workspaces start with daily notes off until someone switches them on; a personal workspace starts with them on."
        />

        <Field label="Folders" className="max-w-sm">
          {(control) => (
            <Select
              {...control}
              value={draft.folders}
              onChange={(event) => {
                const folders = FOLDER_OPTIONS.find(
                  (option) => option.value === event.currentTarget.value,
                )?.value;
                if (folders !== undefined) change({ ...draft, folders });
              }}
            >
              {FOLDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Title" className="max-w-sm">
          {(control) => (
            <Select
              {...control}
              value={draft.titleFormat}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === 'iso' || value === 'long' || value === 'weekday-long') {
                  change({ ...draft, titleFormat: value });
                }
              }}
            >
              <option value="iso">{examples.iso}</option>
              <option value="long">{examples.long}</option>
              <option value="weekday-long">{examples['weekday-long']}</option>
            </Select>
          )}
        </Field>

        <Field label="Template" hint="Markdown, added to each new daily note" className="max-w-xl">
          {(control) => (
            <Textarea
              {...control}
              rows={8}
              maxLength={4000}
              value={draft.template}
              onChange={(event) => {
                change({ ...draft, template: event.currentTarget.value });
              }}
            />
          )}
        </Field>

        <Field
          label="The day changes at"
          hint="Before this hour, today is still yesterday’s note"
          className="max-w-xs"
        >
          {(control) => (
            <Select
              {...control}
              value={String(draft.rolloverHour)}
              onChange={(event) => {
                const hour = Number(event.currentTarget.value);
                if (Number.isInteger(hour) && hour >= 0 && hour <= 6) {
                  change({ ...draft, rolloverHour: hour });
                }
              }}
            >
              {ROLLOVER_LABELS.map((label, hour) => (
                <option key={label} value={String(hour)}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <PreferenceToggle
          label="Show daily notes on the workspace calendar"
          checked={draft.showOnCalendar}
          onChange={(showOnCalendar) => {
            change({ ...draft, showOnCalendar });
          }}
          description="Each note appears on its date in the calendar"
          unsaved={null}
        />

        <div className="flex flex-col gap-1">
          <div>
            <Button type="submit" disabled={saving || unchanged || !canManage}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
          <Text variant="note" tone="muted">
            Applies to notes created after you save; existing notes keep their place and title
          </Text>
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

function DeviceSettings(): ReactElement {
  // Read once into state: the value lives in browser storage, which React does not observe, and
  // this checkbox is the only writer on the page.
  const [openOnLaunch, setOpenOnLaunch] = useState(readOpenDailyOnLaunch);

  return (
    <div
      className={cn(
        'flex flex-col gap-2 border-t border-divider pt-4', // spacing-role-exempt: a top-border section divider, not the bordered-panel role the p-3 convention belongs to - only its top edge pads.
      )}
    >
      <Text variant="h5" as="h3">
        Your preference
      </Text>
      <PreferenceToggle
        label="Open today’s note when Nix starts"
        checked={openOnLaunch}
        onChange={(next) => {
          setOpenOnLaunch(next);
          writeOpenDailyOnLaunch(next);
        }}
        description="Only changes what you see"
        unsaved={null}
      />
    </div>
  );
}
