import { Button, Dialog, Text } from '@nix/ui';
import { useEffect, useId, useSyncExternalStore, type ReactNode } from 'react';

import {
  acknowledgeDocumentIssues,
  documentIssuesSnapshot,
  emptyDocumentIssues,
  removeDocumentIssues,
  subscribeDocumentIssues,
  updateDocumentIssues,
  type DocumentIssue,
} from '../lib/document-issues';
import type { SyncState } from './collab-sync';
import type { DraftState } from './draft-journal';

export const LOCAL_COPY_STALE = 'local_copy_stale';

/** One modal for all open document bodies, with no healthy-state chrome or repeated retry alerts. */
export function DocumentIssueDialog({
  state,
  draftState,
  noun,
  stale = false,
  refusal = null,
  error = null,
  paused = false,
  reloadRequired = false,
}: {
  readonly state: SyncState;
  readonly draftState?: DraftState | undefined;
  readonly noun: string;
  readonly stale?: boolean;
  readonly refusal?: string | null;
  readonly error?: string | null;
  readonly paused?: boolean;
  readonly reloadRequired?: boolean;
}): ReactNode {
  const id = useId();
  const snapshot = useSyncExternalStore(
    subscribeDocumentIssues,
    documentIssuesSnapshot,
    emptyDocumentIssues,
  );
  useEffect(() => {
    const issues: DocumentIssue[] = [];
    if (stale)
      issues.push({
        key: `stale:${noun}`,
        message: `This ${noun} changed while you were away. You are viewing this device’s older copy, and changes here are not saved. Reload to open the current version.`,
        reload: true,
      });
    if (refusal && !stale)
      issues.push({ key: `refusal:${refusal}`, message: refusal, reload: reloadRequired });
    if (error) issues.push({ key: `error:${error}`, message: error });
    if (draftState === 'error')
      issues.push({
        key: 'local-save',
        message:
          'Nix could not save your edits on this device. Keep this tab open until they sync with the server.',
      });
    const connection: DocumentIssue | null | undefined =
      state === 'connecting'
        ? undefined
        : stale || state === 'live'
          ? null
          : {
              key: state === 'readonly' ? 'read-only' : 'connection',
              message:
                state === 'readonly'
                  ? 'This document is read-only. You can view it, but edits cannot be saved. Any changes made before the connection opened have not been saved to the server.'
                  : state === 'degraded'
                    ? 'Nix cannot sync your open documents right now. Recent edits have not been confirmed by the server. Keep this tab open to protect them. After your edits are safe, reloading may help.'
                    : draftState === 'local'
                      ? 'Nix lost its connection. Changes saved on this device still need server confirmation. Keep this tab open; Nix will reconnect automatically.'
                      : 'Nix lost its connection. Recent edits have not been confirmed by the server. Keep this tab open; Nix will reconnect automatically.',
            };
    updateDocumentIssues(id, issues, connection, paused);
  }, [id, state, draftState, noun, stale, refusal, error, paused, reloadRequired]);
  useEffect(
    () => () => {
      removeDocumentIssues(id);
    },
    [id],
  );

  if (snapshot.host !== id || snapshot.issues.length === 0) return null;
  return (
    <Dialog
      open
      title="Document needs attention"
      onClose={acknowledgeDocumentIssues}
      actions={
        <>
          <Button variant="ghost" onClick={acknowledgeDocumentIssues}>
            Dismiss
          </Button>
          {snapshot.issues.some((issue) => issue.reload) ? (
            <Button
              variant="primary"
              onClick={() => {
                globalThis.location.reload();
              }}
            >
              Reload
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {snapshot.issues.map((issue) => (
          <Text key={issue.key} variant="bodySmall">
            {issue.message}
          </Text>
        ))}
      </div>
    </Dialog>
  );
}
