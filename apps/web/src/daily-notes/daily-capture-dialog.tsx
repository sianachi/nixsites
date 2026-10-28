import { Button, Dialog, Text, Textarea } from '@nix/ui';
import { isCanceledError, isNixApiError, workspaces as coreWorkspaces } from '@nix/api-client';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { useApiClient } from '@nix/web-platform/api/api-client-provider';
import { publishNotice } from '@nix/web-foundation/lib/notices';
import { localDailyNoteDate } from './daily-note';

/**
 * Putting a thought at the end of today's note without leaving what is open.
 *
 * **The body is written through the companion's `append`, not by a second writer.** A note that is
 * not open in an editor has no live document to type into, and the pet's `append_note` tool is
 * the path the app already has for that: it reads the note's updates, adds the new blocks after
 * the existing ones and sends only the difference, so what is already in the note is never
 * reserialised. Reusing it keeps one way of writing a body from outside the editor.
 *
 * **A note this capture creates gets its template here.** Opening a day normally has the editor
 * insert the template once it syncs, but nothing opens the editor now, so the template goes in the
 * same append, ahead of what was typed.
 *
 * The text stays in the box, with the reason, whenever the write does not happen.
 */

const MAX_CAPTURE_LENGTH = 8_000;

export interface DailyCaptureDialogProps {
  readonly open: boolean;
  readonly workspaceId: string;
  readonly onClose: () => void;

  /** Opens a note the way the shell opens any item. */
  readonly onOpenItem: (itemId: string) => void;
}

/** Why the capture did not happen, said in terms of what the person can do about it. */
function failureMessage(reason: unknown): string {
  if (isNixApiError(reason)) {
    if (reason.code === 'workspaces.daily_notes_disabled') {
      return 'Daily notes are switched off for this workspace.';
    }
    if (reason.code === 'workspaces.daily_notes_root_unavailable') {
      return 'The Daily notes folder is unavailable. Restore it from Trash or unlock it before adding to today’s note.';
    }
    return reason.detail ?? 'Today’s note could not be opened.';
  }
  if (reason instanceof Error && reason.message.startsWith('Provide up to')) {
    return 'That is too long to add in one go. Shorten it and try again.';
  }
  return 'Nothing was added. Check the connection and try again.';
}

/** Each non-empty line becomes its own paragraph, so a typed line break is kept. */
function paragraphs(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n\n');
}

export function DailyCaptureDialog(props: DailyCaptureDialogProps): ReactNode {
  const { open, workspaceId, onClose, onOpenItem } = props;

  // The notice's "Open" outlives this dialog's form, so it calls whatever opener is current when it
  // is pressed rather than the one from the render that made it - the route may have changed since.
  const openItem = useRef(onOpenItem);
  useEffect(() => {
    openItem.current = onOpenItem;
  }, [onOpenItem]);

  if (!open) return null;
  return (
    <CaptureForm
      workspaceId={workspaceId}
      onClose={onClose}
      onOpenItem={(itemId) => {
        openItem.current(itemId);
      }}
    />
  );
}

function CaptureForm(props: Omit<DailyCaptureDialogProps, 'open'>): ReactNode {
  const { workspaceId, onClose, onOpenItem } = props;
  const client = useApiClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const body = paragraphs(text);

  async function submit(): Promise<void> {
    if (busy || body === '') return;
    setBusy(true);
    setError(null);
    const abort = new AbortController();
    controller.current = abort;
    try {
      // "Today" depends on the hour the workspace's day changes. If that cannot be read the day is
      // taken to change at midnight and the note is still made, as the daily page does.
      const settings = await client
        .query(coreWorkspaces.dailyNoteSettings(workspaceId), { signal: abort.signal })
        .catch((reason: unknown) => {
          if (isCanceledError(reason)) throw reason;
          return null;
        });
      const date = localDailyNoteDate(new Date(), settings?.rolloverHour ?? 0);
      const { itemId, created } = await client.execute(
        coreWorkspaces.openDailyNote(workspaceId, date),
        { signal: abort.signal },
      );
      const template = created ? (settings?.template.trim() ?? '') : '';
      // Loaded on use: the companion carries the collaborative-document code, which nothing else on
      // the first screen needs.
      const { createCompanionBodies } = await import('@nix/companion');
      await createCompanionBodies(client).append(
        itemId,
        template === '' ? body : `${template}\n\n${body}`,
        abort.signal,
      );
      publishNotice({
        key: 'daily-capture',
        message: 'Added to today’s note',
        action: {
          label: 'Open',
          onAction: () => {
            onOpenItem(itemId);
          },
        },
      });
      onClose();
    } catch (reason: unknown) {
      if (abort.signal.aborted || isCanceledError(reason)) return;
      setError(failureMessage(reason));
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <Dialog
      open
      title="Capture to today’s note"
      onClose={onClose}
      initialFocus={field}
      dirty={text.trim() !== '' && !busy}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || body === ''}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Textarea
          ref={field}
          autoGrow
          className="max-h-64"
          aria-label="Add to today's note"
          aria-invalid={error === null ? undefined : true}
          maxLength={MAX_CAPTURE_LENGTH}
          value={text}
          readOnly={busy}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        {error === null ? null : (
          <Text variant="note" role="alert">
            {error}
          </Text>
        )}
      </div>
    </Dialog>
  );
}
