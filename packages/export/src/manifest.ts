/**
 * The `.nix` archive manifest — ADR-0017.
 *
 * The manifest is the archive's spine: parentage, sibling order and what was left out live here
 * rather than in the payloads, so a reader can reconstruct the tree, decide whether it wants the
 * bodies, and stream them, without opening a single one.
 */

/** What a `.nix` file says it is. A reader that finds anything else should refuse it. */
export const ARCHIVE_FORMAT = 'nix-archive';

/**
 * The archive's own shape.
 *
 * **Deliberately independent of `SCHEMA_VERSION`.** The container and the document block set change
 * for different reasons and on different cadences; one number for both would force a fake bump on
 * whichever side did not change.
 */
export const ARCHIVE_FORMAT_VERSION = 1;

/** Archive v2 adds bounded, checksummed file-version entries while keeping v1 readable. */
export const FILE_ARCHIVE_FORMAT_VERSION = 2;

/** Shared Nix archive ceilings; ZIP entry count includes its manifest and item bundles. */
export const MAX_ARCHIVE_ENTRIES = 100_001;
export const MAX_ARCHIVE_ITEMS = 10_000;
export const MAX_TEMPLATE_ARCHIVE_ENTRIES = 20_201;
export const MAX_TEMPLATE_ARCHIVE_ITEMS = 200;

/** A single item cannot contribute an unbounded number of historical file versions to an archive. */
export const MAX_ARCHIVE_FILE_VERSIONS_PER_ITEM = 100;

/** The manifest's entry name. Always the first entry written, so a reader can stream. */
export const MANIFEST_ENTRY = 'manifest.json';

/** The first file-backed template profile. Kept independent from the archive format version. */
export const TEMPLATE_PROFILE_VERSION = 1;

/**
 * Marks an ordinary `.nix` archive as a reusable template.
 *
 * Optional on the manifest so every archive written before templates remains a valid v1 archive.
 * The flags state what the author chose to capture; a reader never infers that choice from an
 * absent body or a one-item spine, because either can also mean the source simply had none.
 */
export interface TemplateArchiveProfile {
  readonly kind: 'template';
  readonly version: typeof TEMPLATE_PROFILE_VERSION;
  /** Portable identity metadata; authoritative only for a managed boot directory. */
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Whether the template root's own body was captured; descendants retain their selected bodies. */
  readonly includeBody: boolean;
  readonly includeChildren: boolean;
  /** Additive initialization metadata; absent/null means an older uninitialized template. */
  readonly initialization?: TemplateInitialization | null;
}

/** Portable template initialization metadata; Core remains authoritative for semantic validation. */
export interface TemplateInitialization {
  readonly version: 1;
  readonly inputs: readonly TemplateInitializationInput[];
  readonly rules: readonly TemplateInitializationRule[];
  readonly references: readonly TemplateReferenceRule[];
}

export interface TemplateInitializationInput {
  readonly key: string;
  readonly label: string;
  readonly type: 'text' | 'date' | 'member' | 'item';
  readonly required: boolean;
  readonly defaultValue?: string | null | undefined;
}

export interface TemplateInitializationRule {
  readonly sourceId: string;
  readonly propertyKey: string;
  readonly kind: 'keep' | 'clear' | 'set' | 'input' | 'relativeDate';
  readonly value?: unknown;
  readonly inputKey?: string | null | undefined;
  readonly offsetDays?: number | null | undefined;
  readonly timeOfDay?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
}

export interface TemplateReferenceRule {
  readonly sourceItemId: string;
  readonly policy: 'retain' | 'omit' | 'replace';
  readonly inputKey?: string | null | undefined;
}

/** Where an item's payload lives, given its identifier in the source workspace. */
export function itemEntryName(sourceId: string): string {
  return `items/${sourceId}.json`;
}

/**
 * One item's place in the tree.
 *
 * `seq` is a string because it is an `int64` on the wire and JavaScript numbers cannot hold every
 * one of them. Sibling order is data - `ItemResponse.Seq` is documented as "its position among its
 * siblings" and every view renders in it - so rounding it silently would reorder somebody's board.
 */
export interface ArchiveItemEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly seq: string;
  readonly title: string;
  readonly type: string;
}

/** Why something inside the exported subtree is not in the archive. */
export type OmissionReason = 'not-readable' | 'soft-deleted' | 'limit-reached';

/**
 * Something the export could not or would not include.
 *
 * An archive with a hole in it and no comment is a lie about the one property this format sells,
 * so every gap is named. `id` is null where the export knows only that a parent had more children
 * than it took - a listing omits what the caller cannot read entirely, so there is no identifier to
 * report.
 */
export interface Omission {
  readonly id: string | null;
  readonly parentId: string;
  readonly reason: OmissionReason;
  readonly detail: string;
}

/**
 * Something a mapper could not represent in its target format.
 *
 * Empty for `.nix`, and that emptiness is the claim - this is the lossless format, so an entry here
 * is a bug rather than a note. It is defined in the shared manifest because the lossy exporters
 * (Markdown, PDF, DOCX) owe a stated list of what does not survive, and one shape for that list is
 * what lets an import report and an export report be read the same way.
 */
export interface LossEntry {
  readonly itemId: string;
  readonly kind: string;
  readonly detail: string;
}

/** A property as its schema declares it. */
export interface PropertyDefinition {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly options: readonly string[];
  readonly required: boolean;
  /** Formula expression; absent/null on older archives and other property types. */
  readonly expression?: string | null;
  /** Rollup operation and child property key; a count may omit its source. */
  readonly aggregate?: string | null;
  readonly source?: string | null;
  readonly choiceSource?:
    { readonly itemId: string | null; readonly field: string } | null | undefined;
}

/**
 * The property schema in force at an item.
 *
 * **`properties` is the effective set and `declared` is this item's own contribution**, which is
 * the distinction that makes a subtree re-importable. The cascade reaches past whatever boundary an
 * export draws - `GetEffectiveSchemaHandler` merges every ancestor's declaration and says outright
 * that no client can reconstruct them - so an archive carrying only `declared` would land items
 * holding property values that no schema declares.
 */
export interface SchemaSnapshot {
  readonly properties: readonly PropertyDefinition[];
  readonly declared: readonly PropertyDefinition[];
  readonly inherit: boolean;
}

/** A view over an item's children, as stored. */
export interface ViewSnapshot {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly columns: readonly string[];
  readonly groupBy: string | null;
  readonly groupOrder: readonly string[];
  readonly dateProperty: string | null;
  readonly sortBy: string | null;
  readonly sortDescending: boolean;
  readonly mode: string | null;
  readonly coverProperty: string | null;
  readonly endDateProperty: string | null;
  readonly cardSize: string | null;

  /** Added after archive v1 shipped; absent readers treat it as no filters. */
  readonly filters?: readonly FilterRuleSnapshot[];

  /** Added after archive v1 shipped; absent means this view is not composed. */
  readonly companionViewId?: string | null;

  /** Added after archive v1 shipped; absent means this view is not composed. */
  readonly companionPlacement?: 'below' | 'beside' | null;

  /** Added after archive v1 shipped; present only for an Interactive Form view. */
  readonly interactiveForm?: InteractiveFormSnapshot | null;
}

export interface FilterRuleSnapshot {
  readonly property: string;
  readonly operator: string;
  readonly value: string;
}

export interface FormConditionSnapshot {
  readonly fieldBlockId: string;
  readonly operator: string;
  readonly value: string | null;
}

export interface FormBlockSnapshot {
  readonly id: string;
  readonly kind: string;
  readonly propertyKey: string | null;
  readonly text: string;
  readonly help: string | null;
  readonly required: boolean;
  readonly identityRole: string | null;
  readonly visibleWhen: readonly FormConditionSnapshot[];
}

export interface FormPageSnapshot {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly visibleWhen: readonly FormConditionSnapshot[];
  readonly blocks: readonly FormBlockSnapshot[];
}

export interface InteractiveFormSnapshot {
  readonly pages: readonly FormPageSnapshot[];
  readonly titleMode: string;
  readonly titleFieldBlockId: string | null;
  readonly confirmationTitle: string;
  readonly confirmationMessage: string;
}

/**
 * One child, as much of it as a view can show.
 *
 * Its own bundle carries everything; this carries the title and the property values a card, a row
 * or a calendar entry draws. Present even when the child is elsewhere in the archive, because a
 * drawing should not have to go looking for the things it is drawing.
 */
export interface ViewRowSnapshot {
  readonly id: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** One comment as exported. `author` is the display name; an imported comment keeps its original author's. */
export interface CommentSnapshot {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

/** A comment thread as exported; `quote` is the commented text, null for a page-level thread. */
export interface CommentThreadSnapshot {
  readonly id: string;
  readonly quote: string | null;
  readonly resolved: boolean;
  readonly comments: readonly CommentSnapshot[];
}

/** The view set an item offers over its children. */
export interface ViewsSnapshot {
  readonly views: readonly ViewSnapshot[];
  readonly default: string;
}

export interface ArchiveManifest {
  /**
   * Always {@link ARCHIVE_FORMAT}, and typed as a plain string on purpose.
   *
   * A reader parses this out of JSON somebody else wrote, so a literal type here would be a claim
   * the compiler cannot back - and a reader that trusts the field because its type says so is
   * exactly how a hostile archive gets treated as one of ours. The writer checks it instead.
   */
  readonly format: string;
  readonly formatVersion: number;

  /** The `editor-schema` version the bodies in this archive were written against. */
  readonly schemaVersion: number;

  /** Present only when this archive is intended to be installed as a reusable template. */
  readonly profile?: TemplateArchiveProfile;

  readonly exportedAt: string;

  /** The item the export was rooted at. Always present in `items`. */
  readonly root: string;

  /**
   * The effective schema at the root, so an import can re-declare what the root inherited from
   * ancestors that are not in the archive. See {@link SchemaSnapshot}.
   */
  readonly rootEffectiveSchema: SchemaSnapshot | null;

  /** Whether soft-deleted descendants were included. Stated either way. */
  readonly includesDeleted: boolean;

  /** Every item in the archive, parents before children, siblings in `seq` order. */
  readonly items: readonly ArchiveItemEntry[];

  /**
   * File metadata is present only in format v2. Each descriptor maps to the deterministic zip
   * entry `files/<itemId>/<version>.bin`; archive data never chooses its own entry path.
   */
  readonly files?: readonly ArchiveFileVersionEntry[];

  readonly omitted: readonly Omission[];
  readonly loss: readonly LossEntry[];
}

/** Metadata for one immutable file version. Every file item has one current version. */
export interface ArchiveFileVersionEntry {
  readonly itemId: string;
  readonly version: number;
  readonly current: boolean;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly previewable: boolean;
  readonly pixelWidth: number | null;
  readonly pixelHeight: number | null;
}

/** The archive payload for one descriptor; bytes are held for one entry at a time by writers. */
export interface ArchiveFileBytes {
  readonly itemId: string;
  readonly version: number;
  readonly chunks: AsyncIterable<Uint8Array>;
}

/** Returns the only permitted zip path for a file version. */
export function fileVersionEntryName(itemId: string, version: number): string {
  return `files/${itemId}/${String(version)}.bin`;
}

/** An item's payload: what it is, what it carries, and what it says about its children. */
export interface ItemBundle {
  readonly id: string;
  readonly parentId: string | null;
  readonly workspaceId: string;
  readonly type: string;
  readonly title: string;
  readonly seq: string;
  readonly lifecycleState: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly properties: Readonly<Record<string, unknown>>;
  /** Recurrence metadata added after archive v1 shipped; absent means the item does not repeat. */
  readonly recurrence?: unknown;

  /** What this item declares for its children, or null when it declares nothing. */
  readonly schema: SchemaSnapshot | null;

  /** How its children are shown, or null when it offers no views. */
  readonly views: ViewsSnapshot | null;

  /**
   * Enough of its children to draw those views with.
   *
   * **Here because a view is a way of looking at children, and an export of one item carries
   * none.** Without this, choosing "this item" and asking for a PDF produced a document with no
   * board in it - which reads as the feature being broken rather than as the scope being narrow.
   *
   * Deliberately not the children themselves: a card shows a title and a property or two, never a
   * document body, so this carries what a view can show and nothing more. Empty for an item that
   * declares no views, and bounded - `viewRowsTruncated` says when the item has more children than
   * were carried, so a drawing can admit it is partial rather than looking complete.
   */
  readonly viewRows: readonly ViewRowSnapshot[];

  /** Whether the item has more children than {@link ItemBundle.viewRows} carries. */
  readonly viewRowsTruncated: boolean;

  /** Its own document body, or null when it has never been opened. */
  readonly body: ItemBody | null;

  /** Comment threads, present only when the export asked for them and the caller could read them. */
  readonly comments?: readonly CommentThreadSnapshot[];
}

/**
 * An item's own content, in whichever shape its body kind stores it.
 *
 * **One arm per body kind, and a missing arm is a hole in the format's central claim.** A body kind
 * with no arm here reads as `body: null` - indistinguishable from an item nobody has ever opened -
 * so the archive would say "this item has no content" about an item full of it. That is exactly the
 * silent gap ADR-0017 refuses, which is why a new body kind owes an arm here in the same commit
 * that legalises it.
 */
export type ItemBody = ProseBody | SheetBody | CanvasBody;

export interface ProseBody {
  /** The schema version this body was validated against when it was written. */
  readonly schemaVersion: number;

  /** ProseMirror JSON, stored verbatim. This is what makes `.nix` the lossless format. */
  readonly prosemirror: unknown;
}

/** A spreadsheet item's body: the raw cell grid, versioned on its own axis. */
export interface SheetBody {
  /** The sheet schema version, independent of the note schema's. */
  readonly schemaVersion: number;

  /** The cell grid as { body: 'sheet', cells, meta }, stored verbatim. */
  readonly sheet: unknown;
}

/**
 * A canvas item's body: the scene, element by element.
 *
 * Stored as `{ elements }` keyed by element id, which is the client's reconciliation contract
 * rather than a shape invented here - the same JSON `canvasStrategy.materialize` writes to the
 * snapshot. A lossy exporter has nothing to draw a scene with and says so with `body-not-rendered`;
 * `.nix` carries it verbatim, because carrying it is what makes `.nix` lossless.
 */
export interface CanvasBody {
  /**
   * The base schema version. A scene holds no ProseMirror nodes, so nothing in it can require a
   * newer build, and the field is here for uniformity with the other arms rather than to be read.
   */
  readonly schemaVersion: number;

  /** The scene as { elements: { [id]: element } }, stored verbatim. */
  readonly canvas: unknown;
}

/**
 * Whether a string is safe to use as the identifying part of an archive entry name.
 *
 * Identifiers reaching the writer come from Core and are always UUIDs, so this never fires in
 * practice. It is here because "never in practice" is how a path traversal gets written: an entry
 * name is a path, and the check that it cannot contain one belongs at the point where the path is
 * built rather than in the reasoning of whoever calls it.
 */
export function isArchiveSafeId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
