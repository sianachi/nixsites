/**
 * The Nix document schema.
 *
 * One definition of what a document may contain, imported by the web editor to build the
 * editor and by the collaboration service to check that an accepted update still produces
 * a document that parses. Two definitions of the same schema is the failure this package
 * exists to prevent: documents that save on one side and refuse to open on the other.
 */

export type {} from './augmentations.js';
export { CALLOUT_TONES, Callout, type CalloutTone } from './callout.js';
export { Column, ColumnBlock, readWidth } from './columns.js';
/**
 * Columns, in the two tiers a consumer may bind to.
 *
 * The extension is the surface: every column operation is a command on it, so a caller says what
 * it wants and this package decides how. The geometry helpers below it are pure arithmetic over a
 * row, exported because the editor's resize handles need to *report* a width before committing
 * one and there is no transaction to read it from yet.
 *
 * **The `*Tr` transforms are deliberately not here.** They are what the commands are one-line
 * adapters over, and they stay internal - a consumer that bound to a transform instead of a
 * command would make both surfaces real, and then the adapters have to keep two contracts
 * rather than one. The package's own tests import them by relative path, which is the seam
 * working as intended.
 */
export { ColumnEditing } from './column-commands.js';
export {
  MIN_COLUMN_PAIR_SHARE,
  columnGrowFactors,
  columnPairShare,
  resizedColumnWidths,
} from './column-commands.js';
export {
  Details,
  DetailsContent,
  TOGGLE_LEVELS,
  readToggleLevel,
  type ToggleLevel,
} from './details.js';
export { TEXT_COLORS, type TextColor } from './marks.js';
export { isAllowedLinkAddress } from './link-address.js';
export { REFERENCE_KINDS, Reference } from './references.js';
export { nixEditingExtensions, nixExtensions } from './extensions.js';
export {
  SCHEMA_VERSION,
  countNodes,
  emptyDocument,
  nixSchema,
  parseDocument,
  type ParseResult,
} from './schema.js';
export { FIXTURE_DOCUMENT, NODE_FIXTURES, VERSION_1_DOCUMENT } from './fixtures.js';
export { BASE_SCHEMA_VERSION, requiredSchemaVersion } from './versions.js';

export { TEXT_ALIGNMENTS, readTextAlignment } from './text-alignment.js';
export { rejectAllSuggestions } from './reject-suggestions.js';
export { SUGGESTIBLE_BLOCKS, readBlockSuggestion, type BlockSuggestion } from './suggestions.js';
