import { Checkbox, Text, focusRing } from '@nix/ui';
import { useEffect, type ReactElement } from 'react';
import { Link } from 'react-router';

import { publishNotice } from '@nix/web-foundation/lib/notices';
import { useWorkspace } from '@nix/web-workspaces/workspaces/workspace-context';
import { useDailyNoteSettings } from './use-daily-note-settings';

/**
 * Daily notes on or off for the current workspace, as one row of the workspace Options.
 *
 * **The same switch as the Daily notes tab, not a second one.** It loads and saves through the same
 * hook, so the permission rule, the refusal and the refresh of the workspace list are the tab's;
 * a save writes back the whole settings document as loaded with only `enabled` changed. The
 * detailed options stay on the tab, which this links to.
 */
export function DailyNotesSwitch(): ReactElement {
  const { workspaceId, workspace } = useWorkspace();
  const state = useDailyNoteSettings(workspaceId);
  // The rule the Daily notes tab uses: `canRename` is the server's "owner or tenant admin" flag.
  const canManage = workspace.canRename && !state.forbidden;
  const { saved, error } = state;

  useEffect(() => {
    if (error !== null) publishNotice({ key: 'workspace-daily-notes', message: error });
  }, [error]);

  if (saved === null) {
    return state.loading ? (
      <Text role="status" variant="note" tone="muted">
        Loading daily note settings…
      </Text>
    ) : (
      <></>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3">
      <Checkbox
        label="Daily notes"
        checked={saved.enabled}
        disabled={!canManage || state.saving || state.loading}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          void state.save({ ...saved, enabled }).then((ok) => {
            if (ok) {
              publishNotice({
                key: 'workspace-daily-notes',
                message: enabled
                  ? 'Daily notes are on for this workspace.'
                  : 'Daily notes are off for this workspace.',
              });
            }
          });
        }}
      />
      <Text variant="note" tone="muted">
        One note per day.
      </Text>
      <Link to={`/w/${workspaceId}/settings?tab=daily-notes`} className={`${focusRing} underline`}>
        <Text variant="note" as="span">
          Daily notes settings
        </Text>
      </Link>
    </div>
  );
}
