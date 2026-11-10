import { SHEET_LIMITS, cellKey, growExtents, parseCellKey, sheetCellsMap } from '@nix/sheet';
import { Button, Text } from '@nix/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import * as Y from 'yjs';

import { CsvViewer, parseDelimited, serializeDelimited } from '@nix/web-editor/plugins/csv-viewer';
import { SheetGrid } from './sheet-grid';
import { useSheet } from './use-sheet';

/**
 * A CSV or TSV file in the sheet grid: the file's body parsed into a local Y.Doc that is never
 * synced, edited in place, and written back only when the person presses Save. A file that does
 * not fit the sheet's limits keeps the read-only table, which says so.
 */

export interface CsvSheetViewerProps {
  readonly fileName: string;
  readonly source: string;
  /** No Save control, and the grid refuses every edit. */
  readonly readOnly?: boolean;
  /** Writes the text as a new version of the file. Resolves false when the save failed. */
  readonly onSave: (text: string) => Promise<boolean>;
}

type Rows = readonly (readonly string[])[];

function fitsSheet(rows: Rows): boolean {
  let cells = 0;
  for (const row of rows) {
    if (row.length > SHEET_LIMITS.maxCols) return false;
    for (const cell of row) {
      if (cell.length > SHEET_LIMITS.maxRawLength) return false;
      if (cell.length > 0) cells += 1;
    }
  }
  return rows.length <= SHEET_LIMITS.maxRows && cells <= SHEET_LIMITS.maxCells;
}

function buildDoc(rows: Rows): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const cells = sheetCellsMap(doc);
    let maxCol = 0;
    rows.forEach((row, r) => {
      row.forEach((raw, c) => {
        if (raw.length === 0) return;
        cells.set(cellKey({ row: r, col: c }), { raw });
        maxCol = Math.max(maxCol, c);
      });
    });
    growExtents(doc, { row: Math.max(rows.length - 1, 0), col: maxCol });
  });
  return doc;
}

/** The grid's raw cell texts back as rows, so formulas and values round-trip as typed. */
function cellsToText(cells: ReadonlyMap<string, string>, delimiter: ',' | '\t'): string {
  let rows = 0;
  let cols = 0;
  const refs: { row: number; col: number; raw: string }[] = [];
  for (const [key, raw] of cells) {
    const ref = parseCellKey(key);
    if (ref === null) continue;
    rows = Math.max(rows, ref.row + 1);
    cols = Math.max(cols, ref.col + 1);
    refs.push({ ...ref, raw });
  }
  // shortcut: dense rows x cols, fine for files within the limits; a far-corner edit costs more.
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ''));
  for (const { row, col, raw } of refs) {
    const line = grid[row];
    if (line !== undefined) line[col] = raw;
  }
  return rows === 0 ? '' : serializeDelimited(grid, delimiter);
}

export function CsvSheetViewer(props: CsvSheetViewerProps): ReactNode {
  const delimiter = props.fileName.toLowerCase().endsWith('.tsv') ? '\t' : ',';
  const rows = useMemo(() => parseDelimited(props.source, delimiter), [props.source, delimiter]);
  if (!fitsSheet(rows)) return <CsvViewer fileName={props.fileName} source={props.source} />;
  return (
    <CsvSheet
      readOnly={props.readOnly ?? false}
      onSave={props.onSave}
      rows={rows}
      delimiter={delimiter}
    />
  );
}

function CsvSheet({
  readOnly,
  onSave,
  rows,
  delimiter,
}: {
  readonly readOnly: boolean;
  readonly onSave: (text: string) => Promise<boolean>;
  readonly rows: Rows;
  readonly delimiter: ',' | '\t';
}): ReactNode {
  const [doc] = useState(() => buildDoc(rows));
  const sheet = useSheet(doc);
  const text = useMemo(() => cellsToText(sheet.cells, delimiter), [sheet.cells, delimiter]);
  // The baseline is the grid's own serialisation, so normalising the file's quoting is not an edit.
  const [baseline, setBaseline] = useState(text);
  const [saving, setSaving] = useState(false);
  const dirty = text !== baseline;

  useEffect(() => {
    return () => {
      doc.destroy();
    };
  }, [doc]);

  // Browser-level guard only: the app has no router-level blocker to hook into.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      if (await onSave(text)) setBaseline(text);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 px-3 py-1.5 sm:px-8">
        {readOnly ? (
          <Text variant="note" tone="muted" role="status">
            Read-only: you cannot change this file.
          </Text>
        ) : (
          <>
            <Button disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Text variant="note" tone="muted" role="status">
              {dirty
                ? 'Unsaved changes. Save writes a new version of the file.'
                : 'No unsaved changes'}
            </Text>
          </>
        )}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={saving}>
        <SheetGrid sheet={sheet} readOnly={readOnly} />
      </div>
    </div>
  );
}
