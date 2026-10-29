import type { Problem } from '../validate/report.js';

/**
 * One node of a previewed change tree (architecture section 7): what would exist, in plain words,
 * never JSX and never raw JSON. `why` is model-authored (a `FieldSpec`/`ViewSpec`/`Node`'s own
 * `why`) and is rendered as plain text only - it is advisory, never structural, so a node with no
 * `why` is exactly as valid as one with one.
 */
export interface PreviewNode {
  label: string;
  detail: string[];
  why?: string;
  children: PreviewNode[];
}

/**
 * What `@nix/structure-spec/describe` and `@nix/companion`'s `describeToolCall` hand back for a
 * pending tool call: a first-person headline, where it lands, enough counts for a summary line
 * without the caller re-deriving them, the change tree itself, and the fixed list of writes this
 * executor never performs (architecture section 7, "Approval UX architecture"). `problems` (from
 * `ValidationReport`) block approval; `warnings` do not. Every string here is plain text - the
 * renderer (`packages/web-pets/src/pets/pet-structure-preview.tsx`, task A.6) never runs Markdown or
 * `dangerouslySetInnerHTML` over any of it, because every string in this model may have been
 * chosen by the model that proposed the change.
 */
export interface PreviewModel {
  headline: string;
  destination: { title: string; path: string[] };
  counts: { items: number; fields: number; views: number; entries: number; writes: number };
  tree: PreviewNode[];
  notes: string[];
  warnings: Problem[];
  problems: Problem[];
  neverDoes: string[];
  /** Present only for an edit inside a note body (`replace_section`, `replace_passage`): the
   * Markdown the edited blocks render to now and after the edit, so a card can show both side by
   * side and the owner sees any formatting the round trip would lose before approving. */
  bodyEdit?: PreviewBodyEdit;
}

/** A run of characters, `start` inclusive and `end` exclusive. */
export interface PreviewTextRange {
  start: number;
  end: number;
}

/** What a body edit touches: a whole section, or the one block a passage sits in. */
export type PreviewBodyEditScope =
  'section' | 'paragraph' | 'list item' | 'heading' | 'code block' | 'table cell';

export interface PreviewBodyEdit {
  scope: PreviewBodyEditScope;
  /** Names the edited text and the note it is in, e.g. `Section “Packing” in Trip plan`, so two
   * comparisons on screen never share a name. */
  subject: string;
  /** For a passage: the characters of `before` that change and the characters of `after` that
   * replace them. A section has none; its comparison diffs by line. */
  beforeRange?: PreviewTextRange;
  afterRange?: PreviewTextRange;
  /** The edited blocks as they read now, as Markdown. */
  before: string;
  /** The same blocks as they will read after the edit, as Markdown. */
  after: string;
  blocksRemoved: number;
  /** Whether the replaced blocks carry formatting Markdown cannot keep. Such an edit always waits
   * for the owner, even when a conversation applies changes without asking. */
  losesFormatting: boolean;
  blocksAdded: number;
}
