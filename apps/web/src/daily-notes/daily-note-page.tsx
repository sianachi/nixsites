import { Button, Text, focusRing } from '@nix/ui';
import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { offerDailyTemplate } from '@nix/web-foundation/lib/pending-daily-template';
import { useWorkspace } from '../workspaces/workspace-context';
import { dailyNoteLabel, localDailyNoteDate, parseDailyNoteDate } from './daily-note';
import { useDailyNoteSettings } from './use-daily-note-settings';

/** Why opening failed, with where to go to fix it when that is somewhere. */
interface OpenFailure {
  readonly message: string;
  readonly fix: 'settings' | 'trash' | null;
}

function openFailure(reason: unknown): OpenFailure {
  if (isNixApiError(reason)) {
    if (reason.code === 'workspaces.daily_notes_disabled') {
      return { message: 'Daily notes are switched off for this workspace.', fix: 'settings' };
    }
    if (reason.code === 'workspaces.daily_notes_root_unavailable') {
      return {
        message:
          'The Daily notes folder is unavailable. Restore it from Trash or unlock it in the workspace.',
        fix: 'trash',
      };
    }
    // The day's own note, rather than its folder, is what stands in the way. The server's detail is
    // kept because it is the more specific statement; the fallback says the same thing.
    if (reason.code === 'workspaces.daily_note_in_trash') {
      return {
        message: reason.detail ?? 'This day’s note is in Trash. Restore it from Trash to open it.',
        fix: 'trash',
      };
    }
    if (reason.code === 'workspaces.daily_note_locked') {
      return {
        message: reason.detail ?? 'This day’s note is locked. Unlock it before opening it.',
        fix: null,
      };
    }
    // Core answers not-found when the caller may not write here, and its detail then speaks of an
    // inaccessible workspace - untrue of the one on screen, so it is not repeated.
    if (reason.code === 'workspaces.not_found') {
      return {
        message:
          'You cannot create or open daily notes in this workspace. Ask an owner for edit access.',
        fix: null,
      };
    }
    return { message: reason.detail ?? 'This daily note could not be opened.', fix: null };
  }
  return {
    message: 'This daily note could not be opened. Check the connection and try again.',
    fix: null,
  };
}

export function DailyNotePage(): ReactNode {
  const { date } = useParams();
  const client = useApiClient();
  const { workspaceId, workspace } = useWorkspace();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<OpenFailure | null>(null);

  // Only the bare address needs the settings before it can act: "today" depends on the hour the
  // workspace's day changes. An explicit date is opened as written and never shifted.
  const settings = useDailyNoteSettings(
    workspaceId,
    date === undefined && workspace.canUseDailyNotes,
  );
  const canonical = date === undefined ? null : parseDailyNoteDate(date);

  useEffect(() => {
    if (!workspace.canUseDailyNotes) return;
    if (canonical === null || date === undefined) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      setError(null);
    });
    void client
      .execute(coreWorkspaces.openDailyNote(workspaceId, canonical), {
        signal: controller.signal,
      })
      .then(async ({ itemId, created }) => {
        if (created) {
          // Offered before the editor opens, so it is there when the note's first sync finishes.
          // The settings are cached; if they cannot be read the note is still made, just empty -
          // a template is a convenience and not worth refusing the day over.
          const template = await client
            .query(coreWorkspaces.dailyNoteSettings(workspaceId), { signal: controller.signal })
            .then((loaded) => loaded.template)
            .catch(() => '');
          if (template.trim() !== '') offerDailyTemplate({ itemId, markdown: template });
        }
        if (controller.signal.aborted) return;
        void navigate(`../../?item=${encodeURIComponent(itemId)}`, {
          replace: true,
          relative: 'path',
        });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || isCanceledError(reason)) return;
        setError(openFailure(reason));
      });
    return () => {
      controller.abort();
    };
  }, [attempt, canonical, client, date, navigate, workspace.canUseDailyNotes, workspaceId]);

  if (!workspace.canUseDailyNotes) {
    return <Navigate replace to={`/w/${workspaceId}`} />;
  }

  if (date === undefined) {
    if (settings.status === 'ready') {
      return (
        <Navigate replace to={localDailyNoteDate(new Date(), settings.settings.rolloverHour)} />
      );
    }
    if (settings.status === 'error') {
      return (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <Text variant="h2" as="h1">
            Daily note could not be opened
          </Text>
          <Text role="alert" tone="muted">
            The daily note settings could not be loaded, so today cannot be worked out.
          </Text>
          <Button variant="secondary" onClick={settings.retry}>
            Try again
          </Button>
        </section>
      );
    }
    return <OpeningNote label={null} />;
  }
  if (canonical === null) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Text variant="h2" as="h1">
          Daily note not found
        </Text>
        <Text tone="muted">The date in this address is not a calendar day.</Text>
      </section>
    );
  }
  if (error !== null) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <Text variant="h2" as="h1">
          Daily note could not be opened
        </Text>
        <Text role="alert" tone="muted">
          {error.message}
        </Text>
        {error.fix === null ? null : (
          <Link
            to={
              error.fix === 'settings'
                ? `/w/${workspaceId}/settings?tab=daily-notes`
                : `/w/${workspaceId}/trash`
            }
            className={`${focusRing} underline`}
          >
            <Text variant="note" as="span">
              {error.fix === 'settings' ? 'Open Daily notes settings' : 'Open Trash'}
            </Text>
          </Link>
        )}
        <Button
          variant="secondary"
          onClick={() => {
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </section>
    );
  }
  return <OpeningNote label={dailyNoteLabel(canonical)} />;
}

function OpeningNote({ label }: { readonly label: string | null }): ReactNode {
  return (
    <section
      className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center"
      role="status"
    >
      <Text variant="h2" as="h1">
        Opening daily note
      </Text>
      {label === null ? null : <Text tone="muted">{label}</Text>}
    </section>
  );
}
