import { Text } from '@nix/ui';
import { useMemo, type ReactElement } from 'react';

import { bareMediaType, fileExtension, type FileViewerPlugin } from './file-viewer-registry';

/**
 * Comma- and tab-separated values, shown as the table they are.
 *
 * A spreadsheet export opened as a wall of commas is the file-page failure a team notices first.
 * The parser is RFC 4180: quoted fields, doubled quotes, newlines inside quotes. The delimiter is
 * the tab when the extension says so, otherwise the comma. The first row is treated as a header,
 * which is true of nearly every file a person would open here and harmless when it is not.
 */

/** Rows past this are counted, not drawn. A million-row export is a download, not a page. */
export const CSV_VIEWER_ROW_LIMIT = 500;

export function isDelimitedFile(fileName: string, mediaType: string): boolean {
  const type = bareMediaType(mediaType);
  if (type === 'text/csv' || type === 'text/tab-separated-values') {
    return true;
  }
  const extension = fileExtension(fileName);
  return extension === 'csv' || extension === 'tsv';
}

export function parseDelimited(
  source: string,
  delimiter: ',' | '\t',
): readonly (readonly string[])[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline produces one empty row, which nobody wants to see.
  return rows.filter((cells, index) => index < rows.length - 1 || cells.some((c) => c.length > 0));
}

export function CsvViewer({
  fileName,
  source,
}: {
  readonly fileName: string;
  readonly source: string;
}): ReactElement {
  const rows = useMemo(
    () => parseDelimited(source, fileExtension(fileName) === 'tsv' ? '\t' : ','),
    [fileName, source],
  );
  const header = rows[0] ?? [];
  const body = rows.slice(1, 1 + CSV_VIEWER_ROW_LIMIT);
  const hidden = Math.max(0, rows.length - 1 - body.length);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {hidden > 0 ? (
        <Text variant="note" tone="muted" as="p" role="status" className="px-2 py-2 sm:px-8">
          Showing the first {String(CSV_VIEWER_ROW_LIMIT)} of {String(rows.length - 1)} rows.
          Download the file for the rest.
        </Text>
      ) : null}
      <div
        role="region"
        aria-label={`${fileName} table`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll wider tables.
        tabIndex={0}
        className="min-h-0 min-w-0 flex-1 overflow-auto px-2 py-4 sm:px-8"
      >
        <table aria-label={fileName} className="border-collapse text-sm">
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th
                  key={index}
                  scope="col"
                  className="sticky top-0 border border-divider bg-surface px-3 py-1.5 text-left font-semibold whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((cells, rowIndex) => (
              <tr key={rowIndex}>
                {header.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="border border-divider px-3 py-1.5 align-top whitespace-nowrap"
                  >
                    {cells[cellIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const csvViewerPlugin: FileViewerPlugin = {
  id: 'nix.csv.viewer',
  matches: ({ fileName, mediaType }) => isDelimitedFile(fileName, mediaType),
  Component: CsvViewer,
};
