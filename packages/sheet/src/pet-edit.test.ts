import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { evaluateSheet } from './engine.js';
import { readCells, readMeta, writeCell } from './model.js';
import { applySheetEdit, invertSheetEdit, previewSheetEdit } from './pet-edit.js';

describe('reviewed sheet edits', () => {
  it('previews and applies native formulas, grid growth and column widths, then undoes only the edit', () => {
    const doc = new Y.Doc();
    writeCell(doc, { row: 0, col: 0 }, '6');
    const changes = previewSheetEdit(doc, {
      cells: [
        { cell: 'B1', value: '=A1*2' },
        { cell: 'AC123', value: 'Note' },
      ],
      columnWidths: [{ column: 'B', width: 160 }],
    });
    expect(changes).toEqual([
      { kind: 'cell', cell: 'B1', before: null, after: '=A1*2' },
      { kind: 'cell', cell: 'AC123', before: null, after: 'Note' },
      { kind: 'width', column: 'B', before: null, after: 160 },
      { kind: 'extent', axis: 'rows', before: null, after: 123 },
      { kind: 'extent', axis: 'cols', before: null, after: 29 },
    ]);
    expect(readCells(doc)).toEqual(new Map([['A1', '6']]));

    applySheetEdit(doc, changes);
    expect(evaluateSheet({ cells: readCells(doc) }).values.get('B1')).toBe(12);
    expect(readMeta(doc)).toEqual({ rows: 123, cols: 29, colWidths: { B: 160 } });

    writeCell(doc, { row: 0, col: 2 }, 'Independent user edit');
    applySheetEdit(doc, invertSheetEdit(changes));
    expect(readCells(doc)).toEqual(
      new Map([
        ['A1', '6'],
        ['C1', 'Independent user edit'],
      ]),
    );
    expect(readMeta(doc)).toEqual({ rows: 100, cols: 26, colWidths: {} });
    doc.destroy();
  });

  it('refuses stale, duplicate or out-of-grid changes without modifying any cells', () => {
    const doc = new Y.Doc();
    const changes = previewSheetEdit(doc, {
      cells: [
        { cell: 'B1', value: 'First' },
        { cell: 'A1', value: 'Second' },
      ],
      columnWidths: [],
    });
    writeCell(doc, { row: 0, col: 0 }, 'Newer edit');
    expect(() => {
      applySheetEdit(doc, changes);
    }).toThrow('The sheet changed');
    expect(readCells(doc)).toEqual(new Map([['A1', 'Newer edit']]));
    expect(() =>
      previewSheetEdit(doc, {
        cells: [
          { cell: 'B1', value: 'First' },
          { cell: 'B1', value: null },
        ],
        columnWidths: [],
      }),
    ).toThrow('duplicate target B1');
    expect(() =>
      previewSheetEdit(doc, {
        cells: [{ cell: 'B10001', value: 'Outside' }],
        columnWidths: [],
      }),
    ).toThrow('outside the sheet grid');
    doc.destroy();
  });

  it('refuses an undo that would hide another collaborator’s new cells', () => {
    const doc = new Y.Doc();
    const changes = previewSheetEdit(doc, {
      cells: [{ cell: 'B150', value: 'Pet edit' }],
      columnWidths: [],
    });
    applySheetEdit(doc, changes);
    writeCell(doc, { row: 135, col: 0 }, 'Independent user edit');

    expect(() => {
      applySheetEdit(doc, invertSheetEdit(changes));
    }).toThrow('Undo would hide another cell');
    expect(readCells(doc).get('B150')).toBe('Pet edit');
    expect(readCells(doc).get('A136')).toBe('Independent user edit');
    expect(readMeta(doc).rows).toBe(150);
    doc.destroy();
  });
});
