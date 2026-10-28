import { SHEET_CELLS_KEY } from '@nix/sheet';
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useAuth } from '../../auth/auth-provider';
import { useSessionStore } from '@nix/web-foundation/lib/session-store';
import { documentScope } from '@nix/web-foundation/lib/body-cache';
import { startCollabSync, type CollabSync, type SyncState } from '../../editor/collab-sync';
import { PresenceList } from '../../editor/presence-list';
import { DocumentIssueDialog, LOCAL_COPY_STALE } from '../../editor/document-issue-dialog';
import { SheetGrid } from './sheet-grid';
import { useSheet } from './use-sheet';

/**
 * The spreadsheet body: a cell grid over a Yjs document, synchronised through
 * the same collaboration service, transport and presence as the note and
 * canvas bodies - a body kind, not a second system.
 *
 * The document shape and the formula engine live in `@nix/sheet`, which the
 * collaboration service also imports: an update this editor produces is
 * validated by the same code that produced it, and the values a colleague
 * sees are computed by the same engine that computed yours. Unlike the
 * canvas, the grid needs no reconciliation binding - the shared `Y.Map` it
 * reads and writes through `useSheet` already is the state, the same way
 * `ySyncPlugin` makes the shared fragment the note's state.
 *
 * Keyed on the item by its caller, exactly as the other bodies are, so
 * switching items builds a fresh document rather than merging two.
 */

export interface SheetEditorProps {
  readonly itemId: string;
  readonly documentPath?: string | undefined;
  readonly onSync?: ((sync: CollabSync | null) => void) | undefined;
  /**
   * Keep a local copy of this body so reopening it paints at once (see `body-cache.ts`). Off
   * unless the page says so: only a page that has read the item's lock state knows the body
   * carries no lock, and a locked body is never kept on disk.
   */
  readonly cacheBody?: boolean;
  /** The item's own controls - details and actions - when they live in this bar on a phone. */
  readonly itemControls?: ReactNode;
}

/**
 * What a refused update means for a person looking at a grid, for the codes
 * a sheet can actually reach today. Codes with no entry here (schema version
 * mismatches, unreadable payloads) are transport-level and already surface
 * through the document issue dialog's connection state.
 */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  schema_version_mismatch:
    'This sheet requires a newer version of Nix. Reload to update before making more changes.',
  document_too_many_nodes:
    'This sheet has more cells than can be saved. Recent edits are not saved - remove some cells and they will send.',
  document_too_large:
    'This sheet is too large to save. Recent edits are not saved - remove some content and they will send.',
  local_copy_stale: 'This sheet changed while you were away. Reload to open the current version.',
  editing_elsewhere: 'Someone else is editing this sheet. You can edit when they leave.',
  document_does_not_parse:
    'This sheet cannot be saved as written - a cell holds something the sheet format cannot store, or a formula is too expensive to finish recalculating.',
};

export function SheetEditor({
  itemId,
  documentPath,
  onSync,
  cacheBody = false,
  itemControls,
}: SheetEditorProps): ReactNode {
  const { getAccessToken } = useAuth();
  const profile = useSessionStore((state) => state.profile);
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const [syncState, setSyncState] = useState<SyncState>('connecting');
  const [readOnly, setReadOnly] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [noticeCode, setNoticeCode] = useState<string | null>(null);
  // A stale local copy must remain read-only until the current version is loaded.
  const [stale, setStale] = useState(false);

  // One document per item, created exactly once via useState's lazy initializer - unlike
  // useMemo, which is only a performance hint React is free to discard and recompute,
  // useState's initial value truly runs once per mount - and destroyed with the component, so
  // switching sheets cannot carry one sheet's cells into another.
  const [doc] = useState(() => new Y.Doc());
  const [awareness] = useState(() => new Awareness(doc));
  const sheet = useSheet(doc);

  useEffect(() => {
    const sync = startCollabSync({
      itemId,
      documentPath,
      cacheScope: cacheBody
        ? documentScope(profile?.subject, workspaceId, itemId, documentPath ?? 'sheet')
        : undefined,
      doc,
      awareness,
      fragmentName: SHEET_CELLS_KEY,
      getAccessToken,
      onState: (state) => {
        if (state === 'readonly') setReadOnly(true);
        else if (state === 'live') setReadOnly(false);
        // A fresh connection means whatever was refused before may not apply to what is
        // about to be resynced - the error is for the last update, not a standing fact.
        if (state === 'live') {
          setRefusal(null);
          setNoticeCode(null);
        }
        setSyncState(state);
      },
      onNotice: (notice) => {
        setNoticeCode(notice.code);
        if (notice.code === LOCAL_COPY_STALE) setStale(true);
        const copy = REFUSAL_COPY[notice.code];
        if (copy !== undefined) {
          setRefusal(copy);
        }
      },
    });
    onSync?.(sync);
    return () => {
      onSync?.(null);
      sync.destroy();
    };
  }, [
    awareness,
    doc,
    documentPath,
    getAccessToken,
    itemId,
    onSync,
    profile?.subject,
    workspaceId,
    cacheBody,
  ]);

  useEffect(() => {
    awareness.setLocalStateField('user', {
      name: profile?.name ?? 'Someone',
      color: 'var(--color-accent)',
    });
  }, [awareness, profile]);

  useEffect(() => {
    return () => {
      awareness.destroy();
      doc.destroy();
    };
  }, [awareness, doc]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-1 px-3 py-1.5 sm:px-8">
        <PresenceList awareness={awareness} />
        {itemControls}
      </div>

      {/* The server's read-only mode and stale copies cannot save cell edits. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={stale || readOnly}>
        <SheetGrid sheet={sheet} />
      </div>

      <DocumentIssueDialog
        noun="sheet"
        state={syncState}
        stale={stale}
        refusal={refusal}
        reloadRequired={noticeCode === 'schema_version_mismatch'}
        error={
          sheet.budget.exceeded
            ? 'This sheet is too large to finish recalculating. Some cells show #LIMIT! until you remove formulas or ranges.'
            : null
        }
      />
    </div>
  );
}
