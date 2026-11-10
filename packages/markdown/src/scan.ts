/**
 * Losses observed while Markdown is parsed for import.
 *
 * The parser owns these counts because only its token stream knows whether source text is code,
 * an Obsidian reference, or an image Nix can actually represent. Keeping the small type and zero
 * value on this light subpath lets the CLI describe empty/container entries without loading the
 * ProseMirror mapping into every command.
 */

export interface MarkdownImportScan {
  /** `[[target]]` references retained as literal text rather than resolved to Nix items. */
  readonly unresolvedWikiLinks: number;
  /** `![[target]]` references retained as literal text rather than embedded. */
  readonly unresolvedObsidianEmbeds: number;
  /** Filesystem image paths retained as text or links instead of broken browser image requests. */
  readonly unresolvedLocalImages: number;
  /** Image addresses Nix cannot persist as displayable images, retained as readable text. */
  readonly unsupportedImageAddresses: number;
  /** Images in an inline-only position represented as ordinary links or readable text. */
  readonly inlineImagesFlattened: number;
  /** Leftover syntax kept as literal text outside code, by kind (bold-marker, html-tag, math, highlight, footnote). Absent when there is none. */
  readonly rawSyntax?: Readonly<Record<string, number>>;
}

/** The immutable loss value for an empty body or a generated container. */
export const EMPTY_MARKDOWN_IMPORT_SCAN: MarkdownImportScan = Object.freeze({
  unresolvedWikiLinks: 0,
  unresolvedObsidianEmbeds: 0,
  unresolvedLocalImages: 0,
  unsupportedImageAddresses: 0,
  inlineImagesFlattened: 0,
});

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[a-zA-Z]:(?:[\\/]|%5c)/i;
const SAFE_DATA_IMAGE = /^data:image\/(?:gif|png|jpeg|webp);/i;

/** Whether an image destination names a filesystem path rather than an address. */
export function isLocalImageTarget(value: string): boolean {
  const target = value.trim();
  if (target.length === 0 || target.startsWith('//')) {
    return false;
  }
  if (WINDOWS_DRIVE.test(target) || target.startsWith('\\\\')) {
    return true;
  }
  if (target.toLowerCase().startsWith('file:')) {
    return true;
  }
  return !SCHEME.test(target);
}

/** Whether an image target already has a durable, self-contained browser representation. */
export function isPersistableImageTarget(value: string): boolean {
  if (SAFE_DATA_IMAGE.test(value)) {
    return true;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
