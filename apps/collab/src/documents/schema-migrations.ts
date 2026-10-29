import { SCHEMA_VERSION } from '@nix/editor-schema';
import type * as Y from 'yjs';

import type { ContentDocRow } from '../db/documents.ts';
import type { ScopedQuery } from '../db/tenant-scope.ts';
import { strategyFor } from './body-kinds.ts';
import { loadDocument } from './service.ts';

/**
 * How a document's stored schema version is raised.
 *
 * **A pin is a promise, and this is what keeps it.** `content_doc.schema_version` says "no
 * build older than this is needed to open me". When the schema gains a node, every existing
 * document is still perfectly readable - the node set only widens - but its pin is now
 * understating what this build might write into it. Raising the pin is what closes that gap,
 * and until the pin is raised `judgeCandidate` and `checkMergedDocument` refuse to write
 * anything above it. So a document is never in a state where the pin lies: it is either
 * pinned low and held to the old node set, or pinned high and free.
 *
 * **Most migrations rewrite nothing.** Adding optional nodes and marks needs no content
 * change at all, so `rewrite` is absent and the migration is a pin bump with a parse check in
 * front of it.
 *
 * **A document that does not parse is left alone.** Force-bumping it would move a broken
 * document from "openable by an old build, broken on a new one" to "broken everywhere", which
 * is strictly worse and irreversible. It is reported instead, with its identifier, so somebody
 * can look at it.
 */
export interface SchemaMigration {
  /** The pin this migration applies to. */
  readonly from: number;

  /** The pin it raises documents to. Always `from + 1`; the runner walks one step at a time. */
  readonly to: number;

  /** One line for the operator's log, saying what changed and why. */
  readonly describe: string;

  /**
   * Transforms the document's content, when the step needs it.
   *
   * **Declared, and not yet implemented by the runner - which refuses to run a step that has
   * one.** Every step so far is additive, so none has needed content to move, and writing the
   * append path speculatively would mean shipping an untested transformation of the whole
   * corpus. The refusal is the point: a hook that silently discarded its own output would
   * migrate every pin, report success, and leave the content untransformed with no way back.
   *
   * Implementing it means capturing the state vector before the step, encoding the delta after
   * it, and appending that through {@link appendUpdate} inside the same transaction as the pin
   * write, so the change lands in the log like any other edit rather than as a silent rewrite
   * of history. Decide the synthetic actor at that point, not now.
   */
  readonly rewrite?: (state: Y.Doc) => void;
}

/**
 * Every step, in order, oldest first.
 *
 * The list is append-only. Editing a step that has already run somewhere produces two
 * databases that both claim to be at the same version and are not.
 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    from: 1,
    to: 2,
    describe:
      'Columns, collapsible sections, references, the table of contents and breadcrumb ' +
      'blocks, token-named colour and the comment mark. Every addition is optional, so no ' +
      'stored content changes: a version-1 document parses unchanged against version 2, and ' +
      'this step raises the pin and nothing else.',
  },
  {
    from: 2,
    to: 3,
    describe:
      'Durable file-backed images. Existing documents parse unchanged; this raises their pins so ' +
      'an older client cannot discard a file image reference written by this build.',
  },
  {
    from: 3,
    to: 4,
    describe: 'Block item references and explicit page breaks; existing content is unchanged.',
  },
  {
    from: 4,
    to: 5,
    describe: 'Text block alignment; existing content is unchanged.',
  },
  {
    from: 5,
    to: 6,
    describe: 'Captured Mermaid pictures on code blocks; existing content is unchanged.',
  },
  {
    from: 6,
    to: 7,
    describe: 'Embed views and suggestion marks; existing content is unchanged.',
  },
];

/** What became of one document. */
export type DocumentOutcome =
  | {
      readonly status: 'migrated';
      readonly docId: string;
      readonly from: number;
      readonly to: number;
    }
  | { readonly status: 'current'; readonly docId: string }
  | { readonly status: 'ahead'; readonly docId: string; readonly pin: number }
  /** Somebody else raised it first - a racing runner, or an overlapping deploy. */
  | { readonly status: 'unchanged'; readonly docId: string }
  /** The document is fine; the target is below what it needs. Not a fault, and not a failure. */
  | {
      readonly status: 'aboveTarget';
      readonly docId: string;
      readonly needs: number;
      readonly target: number;
    }
  /** The document does not open. The only outcome that means something is wrong with it. */
  | { readonly status: 'unparseable'; readonly docId: string; readonly pin: number };

/**
 * The tally a run reports, so a deploy step can fail on anything unexpected.
 *
 * `unparseable` means broken and nothing else - it is what the job's exit code is wired to, so
 * anything else folded into it would send somebody hunting a corruption incident that did not
 * happen. A document merely needing a version above the target is `aboveTarget`.
 */
export interface MigrationReport {
  readonly migrated: number;
  readonly current: number;
  readonly ahead: number;
  readonly aboveTarget: number;
  readonly unchanged: number;
  readonly unparseable: readonly string[];
}

/** A tally under construction, folded one outcome at a time rather than held as an array. */
export class MigrationTally {
  #migrated = 0;
  #current = 0;
  #ahead = 0;
  #aboveTarget = 0;
  #unchanged = 0;
  readonly #unparseable: string[] = [];

  /**
   * Folds one outcome in.
   *
   * Counters rather than an array of every outcome: a corpus walk would otherwise retain one
   * object and one identifier string per document for the length of the run - measured at 547
   * bytes each, so 104 MB at two hundred thousand documents - to compute five numbers and a
   * list that should be empty.
   */
  add(outcome: DocumentOutcome): void {
    switch (outcome.status) {
      case 'migrated':
        this.#migrated += 1;
        break;
      case 'current':
        this.#current += 1;
        break;
      case 'ahead':
        this.#ahead += 1;
        break;
      case 'aboveTarget':
        this.#aboveTarget += 1;
        break;
      case 'unchanged':
        this.#unchanged += 1;
        break;
      case 'unparseable':
        this.#unparseable.push(outcome.docId);
        break;
    }
  }

  report(): MigrationReport {
    return {
      migrated: this.#migrated,
      current: this.#current,
      ahead: this.#ahead,
      aboveTarget: this.#aboveTarget,
      unchanged: this.#unchanged,
      unparseable: [...this.#unparseable],
    };
  }
}

/**
 * The steps that carry a document from `pin` to `target`.
 *
 * Throws on a gap. A list missing `1 -> 2` but holding `2 -> 3` would otherwise select the
 * second step alone and raise a document's pin from 1 to 3, skipping whatever the missing step
 * was for - which is the one way this mechanism could quietly corrupt a corpus, so it is
 * checked here rather than left to a test of the list's shape.
 */
export function stepsFrom(
  pin: number,
  target: number = SCHEMA_VERSION,
  steps: readonly SchemaMigration[] = SCHEMA_MIGRATIONS,
): readonly SchemaMigration[] {
  const selected = steps
    .filter((step) => step.from >= pin && step.to <= target)
    .toSorted((left, right) => left.from - right.from);

  let at = pin;
  for (const step of selected) {
    if (step.rewrite !== undefined) {
      // Refused at selection, not skipped at execution. The runner cannot yet append a
      // rewrite's delta to the log, so running the hook would transform nothing, raise every
      // pin, and report success - the one failure this whole mechanism exists to prevent.
      throw new Error(
        `Migration ${String(step.from)} -> ${String(step.to)} declares a content rewrite, ` +
          'and the runner cannot yet append one to the log. Implement the append before ' +
          'shipping this step; running it now would transform nothing and raise every pin.',
      );
    }

    if (step.from !== at) {
      throw new Error(
        `The document schema migration list has a gap: nothing carries a document from ` +
          `version ${String(at)} to ${String(step.from)}. Refusing to skip it.`,
      );
    }
    at = step.to;
  }

  if (at !== target && selected.length > 0) {
    throw new Error(
      `The document schema migration list stops at version ${String(at)}, short of the ` +
        `target ${String(target)}.`,
    );
  }

  return selected;
}

/**
 * Raises one document's pin as far as it can go, checking first that the result parses.
 *
 * The parse check is not ceremony. A document can be unparseable for reasons that have
 * nothing to do with this migration - a bad merge, a truncated log, a bug in a build long
 * gone - and this is the one moment somebody is looking at every document in the corpus at
 * once, so it is the cheapest place to find out. Bumping the pin on a document that will not
 * open is the one outcome this must never produce.
 *
 * Takes the item's body kind because a canvas and a sheet are pinned by the same column and
 * validated by different rules; asking the wrong strategy would report every canvas as
 * unparseable prose.
 *
 * **Does not open a transaction.** The caller decides that, because the common case is a
 * single `UPDATE` that is already atomic and the replay this may do first should not be
 * holding one open - a long log would keep the cluster's vacuum horizon pinned for its whole
 * duration, once per document, across the corpus.
 */
export async function migrateDocument(
  sql: ScopedQuery,
  tenantId: string,
  doc: ContentDocRow,
  bodyKind: string,
  target: number = SCHEMA_VERSION,
): Promise<DocumentOutcome> {
  if (doc.schema_version > target) {
    return { status: 'ahead', docId: doc.doc_id, pin: doc.schema_version };
  }

  if (doc.schema_version === target) {
    return { status: 'current', docId: doc.doc_id };
  }

  // A document with no updates has no content to break, and is the overwhelmingly common
  // case: `openDocument` creates the row the moment somebody opens an item, and the editor
  // seeds nothing into it, so every item anybody has looked at and not typed into is here.
  // It matters that this comes before the parse check, because an empty state does *not*
  // parse - `doc` requires `block+` and an untouched fragment has no children - so checking
  // first would report every never-edited document in the corpus as broken and fail the
  // deploy step on a database in perfect health.
  if (BigInt(doc.head_seq) === 0n) {
    return await finish(sql, tenantId, doc, target);
  }

  // Selection also validates: a gap in the list, or a step declaring a content rewrite the
  // runner cannot yet append, throws here rather than being quietly worked around.
  stepsFrom(doc.schema_version, target);

  const strategy = strategyFor(bodyKind);
  const state = await loadDocument(sql, tenantId, doc);

  try {
    // Measured against the target schema, because that is the question being asked: will this
    // document open on the build we are about to pin it to.
    const measured = strategy.measure(state);
    if (measured === null) {
      return { status: 'unparseable', docId: doc.doc_id, pin: doc.schema_version };
    }

    if (measured.schemaVersion > target) {
      // Not a fault. The document is fine and this run was asked to reach a version below what
      // it needs, which is an ordinary outcome of a canary run against a narrower target.
      return {
        status: 'aboveTarget',
        docId: doc.doc_id,
        needs: measured.schemaVersion,
        target,
      };
    }
  } finally {
    state.destroy();
  }

  return await finish(sql, tenantId, doc, target);
}

/**
 * Writes the new pin and says whether it moved.
 *
 * `schema_version < $3` in the predicate rather than a bare assignment: two runners racing, or
 * a run overlapping a deploy that has already moved a document on, must not walk a pin
 * backwards. The one direction this may ever move is up - and when the predicate matches
 * nothing, the honest report is `unchanged` rather than a `migrated` this run did not do.
 */
async function finish(
  sql: ScopedQuery,
  tenantId: string,
  doc: ContentDocRow,
  target: number,
): Promise<DocumentOutcome> {
  const { rowCount } = await sql.query(
    `UPDATE content_doc
     SET schema_version = $3
     WHERE tenant_id = $1 AND doc_id = $2 AND schema_version < $3`,
    [tenantId, doc.doc_id, target],
  );

  // A driver that does not report a count is taken at its word that the write happened; the
  // alternative is reporting every successful migration as a race.
  return (rowCount ?? 1) === 0
    ? { status: 'unchanged', docId: doc.doc_id }
    : { status: 'migrated', docId: doc.doc_id, from: doc.schema_version, to: target };
}
