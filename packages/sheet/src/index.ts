/**
 * The Nix spreadsheet body.
 *
 * One definition of the cell document and one formula engine, imported by the
 * web editor to draw and recalculate the grid and by the collaboration
 * service to validate updates and materialize snapshots. Both sides computing
 * the same values from the same cells is the property this package exists to
 * hold; a second engine on either side is the bug.
 */

export { type SheetBudgetReport, evaluateSheet } from './engine.js';
export { SHEET_ITEM_TYPE, SHEET_LIMITS, SHEET_SCHEMA_VERSION } from './limits.js';
export {
  SHEET_CELLS_KEY,
  SHEET_COLUMN_WIDTH,
  SHEET_META_KEY,
  type SheetCell,
  type SheetMeta,
  clampColumnWidth,
  growExtents,
  readCells,
  readMeta,
  setColumnWidth,
  sheetCellsMap,
  sheetMetaMap,
  writeCell,
} from './model.js';
export { FORMULA_FUNCTION_NAMES } from './evaluator.js';
export {
  PROPERTY_FORMULA_HELP,
  PROPERTY_FORMULA_LIMITS,
  type PropertyFormula,
  type PropertyFormulaPlan,
  evaluateFormulaPlan,
  evaluatePropertyFormulas,
  formulaFieldNames,
  propertyFormulaProblem,
  planPropertyFormulas,
} from './properties.js';
export {
  type CellRange,
  type CellRef,
  cellKey,
  columnLetters,
  isInBounds,
  normalizeRange,
  parseCellKey,
  rangeContains,
} from './refs.js';
export { checkSheetDocument, checkSheetSnapshot, sheetSnapshot } from './validate.js';
export {
  type CellValue,
  SHEET_ERROR_CODES,
  SHEET_ERROR_HELP,
  type SheetErrorCode,
  formatCellValue,
  isSheetError,
  sheetError,
} from './values.js';
