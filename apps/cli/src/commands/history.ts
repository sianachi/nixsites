/**
 * `nixctl history`: a document's revisions, named versions, and the ability to look at or restore
 * an earlier state.
 *
 * **The history API is document-generic and lives in the collaboration service**, the same one
 * `nixctl note` speaks, so this reuses its session and token handling (`resolveSession`,
 * `requireAccessToken`) and its collab-origin conventions (`session.endpoints.collabUrl`). Reading a
 * revision as Markdown reuses `@nix/markdown`'s `documentToMarkdown`, the same converter `note read`
 * uses for the live document, dynamic-imported so a session that never asks for `--markdown` never
 * loads it.
 *
 * Listing revisions and named versions is a compact table for a person watching a terminal, and the
 * raw collab response everywhere else (piped, or `--json`) - the same split `printResult` already
 * makes for a single object, made explicit here because a table is not something `JSON.stringify`
 * can produce.
 */

import {
  getRevisionState,
  listNamedVersions,
  listRevisions,
  MAX_HISTORY_LIMIT,
  nameVersion,
  restoreRevision,
  type RevisionState,
} from '../history.ts';
import { assertConfirmed, requireAccessToken, resolveSession, type SessionDeps } from './shared.ts';
import { humanReadable, printResult, printTable, type OutputOptions } from '../output.ts';

/** True when a person is watching this run and has not asked for machine output anyway. */
export interface ListHistoryOptions {
  readonly limit?: number | undefined;
  readonly before?: number | undefined;
}

/** Lists revisions, newest first: `nixctl history list <item> [--limit n] [--before seq]`. */
export async function listHistory(
  profileName: string | undefined,
  itemId: string,
  options: ListHistoryOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error(`--limit must be an integer from 1 through ${String(MAX_HISTORY_LIMIT)}.`);
  }
  if (options.before !== undefined && (!Number.isInteger(options.before) || options.before < 0)) {
    throw new Error('--before must be a non-negative integer sequence number.');
  }

  const session = await resolveSession(profileName, deps);
  const token = await requireAccessToken(session);
  const page = await listRevisions({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    limit,
    ...(options.before !== undefined ? { before: options.before } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (humanReadable(output)) {
    printTable(
      ['SEQ', 'FROM', 'ACTOR', 'STARTED', 'ENDED', 'UPDATES', 'NAME'],
      page.revisions.map((revision) => [
        String(revision.seq),
        String(revision.fromSeq),
        revision.actorId,
        revision.startedAt,
        revision.endedAt,
        String(revision.updateCount),
        revision.name ?? '',
      ]),
    );
    return;
  }

  printResult(page, output);
}

export interface ShowHistoryOptions {
  /** Render the revision as Markdown instead of the plaintext collab already computed. */
  readonly markdown?: boolean | undefined;
}

/**
 * Shows a document as it stood at one `seq`: `nixctl history show <item> <seq> [--markdown]`.
 *
 * A person watching a terminal gets the text alone - Markdown when asked, otherwise the plaintext
 * collab returns - so it pastes cleanly. Piped or `--json`, the full collab response comes through
 * unchanged, `document` included, so a script can do its own rendering.
 */
export async function showHistory(
  profileName: string | undefined,
  itemId: string,
  seq: number,
  options: ShowHistoryOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const token = await requireAccessToken(session);
  const state: RevisionState = await getRevisionState({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    seq,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (humanReadable(output)) {
    const text =
      options.markdown === true
        ? (await import('@nix/markdown')).documentToMarkdown(state.document).markdown
        : state.plaintext;
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    return;
  }

  printResult(state, output);
}

/** Requires `--yes`, the same confirmation gate `ws archive` and `ws purge` use. */
/**
 * Restores the document to its state at `seq`, as one new revision: `nixctl history restore <item>
 * <seq>`. History is never deleted by this - the restore is additive - but it does replace what
 * everyone sees as the current document, so it is gated behind `--yes` like the CLI's other
 * irreversible-feeling writes.
 */
export async function restoreHistory(
  profileName: string | undefined,
  itemId: string,
  seq: number,
  confirmed: boolean,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  assertConfirmed(confirmed);
  const session = await resolveSession(profileName, deps);
  const token = await requireAccessToken(session);
  const result = await restoreRevision({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    seq,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  printResult({ restored: true, itemId, seq, headSeq: result.headSeq }, output);
}

/** Names a revision, pinning it against retention: `nixctl history name <item> <seq> "<name>"`. */
export async function nameHistoryVersion(
  profileName: string | undefined,
  itemId: string,
  seq: number,
  name: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  if (name.length === 0 || name.length > 120) {
    throw new Error('A version name must be 1 through 120 characters.');
  }

  const session = await resolveSession(profileName, deps);
  const token = await requireAccessToken(session);
  const version = await nameVersion({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    seq,
    name,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  printResult(version, output);
}

/** Lists a document's named versions: `nixctl history versions <item>`. */
export async function listHistoryVersions(
  profileName: string | undefined,
  itemId: string,
  output: OutputOptions,
  deps: SessionDeps = {},
): Promise<void> {
  const session = await resolveSession(profileName, deps);
  const token = await requireAccessToken(session);
  const result = await listNamedVersions({
    collabUrl: session.endpoints.collabUrl,
    itemId,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (humanReadable(output)) {
    printTable(
      ['SEQ', 'NAME', 'CREATED BY', 'CREATED AT'],
      result.versions.map((version) => [
        String(version.seq),
        version.name,
        version.createdBy,
        version.createdAt,
      ]),
    );
    return;
  }

  printResult(result, output);
}
