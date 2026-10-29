/**
 * The Nix archive format.
 *
 * `.nix` is the lossless native export: an item, its properties, the schema and views it declares,
 * its document body, and its descendants, in one zip. ADR-0017 is the format's decision record and
 * this package is its only writer.
 *
 * The shared item bundle, document visitor and loss vocabulary also support Markdown mapping
 * and view previews. PDF and DOCX conversion belongs to the Go export worker.
 */

export { exportFileName, writeArchive } from './archive.js';
export {
  type ConvertRequest,
  type DocumentConverter,
  type ExportFormat,
  type LossNotice,
  type PrintPalette,
} from './converter.js';
export {
  LOSS_KINDS,
  createLossReport,
  type LossKind,
  type LossReport,
  type LossSink,
} from './loss.js';
export {
  readBoolean,
  readNumber,
  readString,
  visitProse,
  type NodeHandler,
  type NodeHandlers,
  type ProseNode,
} from './visit.js';
export {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  FILE_ARCHIVE_FORMAT_VERSION,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ITEMS,
  MAX_TEMPLATE_ARCHIVE_ENTRIES,
  MAX_TEMPLATE_ARCHIVE_ITEMS,
  MANIFEST_ENTRY,
  MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM,
  TEMPLATE_PROFILE_VERSION,
  isArchiveSafeId,
  fileVersionEntryName,
  itemEntryName,
  type ArchiveFileBytes,
  type ArchiveFileVersionEntry,
  type ArchiveManifest,
  type ItemBody,
  type TemplateArchiveProfile,
  type TemplateInitialization,
  type TemplateInitializationInput,
  type TemplateInitializationRule,
  type TemplateReferenceRule,
  type CommentSnapshot,
  type CommentThreadSnapshot,
  type ItemBundle,
  type LossEntry,
  type Omission,
  type PropertyDefinition,
  type SchemaSnapshot,
  type ViewRowSnapshot,
  type ViewSnapshot,
  type ViewsSnapshot,
} from './manifest.js';
export {
  TEMPLATE_ARCHIVE_LIMITS,
  TEMPLATE_IMPORT_REQUEST_BYTES,
  parseArchiveObject,
  parseStoredViewsObject,
  readArchive,
  requireTemplateProfile,
  validateTemplateArchive,
  type ReadArchiveResult,
} from './reader.js';
export { readBundleStream, type BundleStream } from './bundle-stream.js';
