/**
 * `nixctl import`: preview and import a document or Markdown folder into a workspace.
 *
 * A single `.nix`, PDF, DOCX, or TXT document uses the durable Core/RabbitMQ/Go path and publishes
 * atomically only after its body and retained files are ready. Markdown folders retain the existing
 * client-side traversal so their per-file mapping and partial-write report remain compatible.
 *
 * The report is the point. Every file the walk meets ends up in exactly one bucket - created,
 * skipped (with why), failed (with why), or not attempted (because its parent failed or the run
 * stopped) - and what a created item still lost (a body write or a property patch that was
 * refused) is declared on its own row, so "what was mapped and what was dropped" is answered by
 * the output rather than by re-reading the tree. Wiki links, Obsidian embeds, local/unsupported
 * image targets, and inline image flattening are measured by the body parser and declared. A
 * `--dry-run` prints the same mapping without touching the network, which is the
 * preview-before-commit 7.5 asks the host to render. Anything short of a complete import leaves
 * with a non-zero exit code, after the report has been printed.
 *
 * **It stops honestly on Core's write rate limit**, the same way `stress seed` does: a large tree
 * meets the per-IP write cap, and when it does the import keeps what it made, lists everything it
 * did not attempt, and names the override to raise - never a hang, never a silent partial dressed
 * as a whole. There is no resume: removing the partial import (`nixctl item rm <rootItemId>`) and
 * running again is the honest path, and the report says so.
 *
 * The Markdown tree - paths, front matter, and bodies - is held in memory for that lane. Worker
 * document uploads and object downloads are streamed and bounded.
 *
 * The web application carries a twin of this run loop (`packages/web-workspaces/src/import/import-run.ts`): the
 * transports differ, but the bucket names, the stop policy, and "the root is the first thing
 * created" must stay in step between the two, so a change to any of those here owes the same
 * change there.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { imports, isNixApiError, items, operations, structure } from '@nix/api-client';
// The subpaths, not the package root: the root re-exports the whole Markdown mapping, and a static
// import of it here would load ProseMirror into every command - the cold start §2.4 protects.
import { noteFromMarkdown } from '@nix/markdown/front-matter';
import { EMPTY_MARKDOWN_IMPORT_SCAN, type MarkdownImportScan } from '@nix/markdown/scan';
import type { FromMarkdownResult } from '@nix/markdown/from-markdown';
import { resolveSession, type SessionDeps } from './shared.ts';
import { ExitCode, printResult, toFailure, type OutputOptions } from '../output.ts';

/** The override to name when the import meets the write rate limit, so a person can raise it. */
const WRITES_LIMIT_OVERRIDE = 'Nix__RateLimits__WritesPerMinute';

export interface ImportOptions {
  readonly path: string;
  readonly workspaceId: string;
  /** The container to import under; the workspace root when omitted. */
  readonly parentId?: string | undefined;
  /** Map and validate without writing anything - the preview before the commit. */
  readonly dryRun: boolean;
  /** Return after the worker accepts the preview job, leaving the durable import recoverable. */
  readonly noWait?: boolean;
}

/** One source file or directory, resolved to what the import will make of it. */
interface PlannedEntry {
  readonly path: string;
  readonly kind: 'note' | 'container';
  readonly title: string;
  /** Front matter values to set, minus the `title` key the item itself consumes. */
  readonly properties: Readonly<Record<string, unknown>>;
  /** The Markdown body after the front matter, empty for containers and stub files. */
  readonly body: string;
  /** Front matter lines that could not be mapped, declared rather than dropped. */
  readonly droppedFrontMatter: readonly string[];
  /** Parser-observed changes in how the source can be represented in a Nix body. */
  readonly scan: MarkdownImportScan;
  readonly children: readonly PlannedEntry[];
}

interface SkippedEntry {
  readonly path: string;
  readonly reason: string;
}

interface FailedEntry {
  readonly path: string;
  readonly reason: string;
}

/** A row for a created item, carrying any loss - a refused body or property write - by name. */
interface CreatedEntry {
  readonly path: string;
  readonly itemId: string;
  readonly title: string;
  readonly properties: readonly string[];
  /** The Yjs delta the body write posted; 0 when there was no body to write, or it failed. */
  bodyBytes: number;
  /** The refusal, verbatim, when the item was created but its body could not be written. */
  bodyError?: string;
  /** The refusal, verbatim, when the item was created but its properties could not be set. */
  propertiesError?: string;
  readonly droppedFrontMatter: readonly string[];
  readonly unresolvedWikiLinks: number;
  readonly unresolvedObsidianEmbeds: number;
  readonly unresolvedLocalImages: number;
  readonly unsupportedImageAddresses: number;
  readonly inlineImagesFlattened: number;
}

/** Imports a Markdown file or folder tree under a parent and prints the mapping report. */
export async function runImport(
  profileName: string | undefined,
  options: ImportOptions,
  output: OutputOptions,
  deps: SessionDeps = {},
  execution: {
    readonly writeResult?: (value: unknown) => void;
    readonly setExitCode?: boolean;
    readonly onDocumentImportStarted?: (importId: string) => void;
  } = {},
): Promise<void> {
  const writeResult =
    execution.writeResult ??
    ((value: unknown) => {
      printResult(value, output);
    });
  const setExitCode = execution.setExitCode ?? true;
  const skipped: SkippedEntry[] = [];
  const failed: FailedEntry[] = [];

  const documentFormat = asDocumentFormat(options.path);
  if (options.noWait === true && options.dryRun) {
    throw new Error('--no-wait cannot be combined with --dry-run.');
  }
  if (options.noWait === true && documentFormat === null) {
    throw new Error('--no-wait is available only for PDF, DOCX, TXT, and Nix document imports.');
  }
  if (documentFormat !== null) {
    await runWorkerDocumentImport(
      profileName,
      options,
      documentFormat,
      deps,
      writeResult,
      execution.onDocumentImportStarted ??
        ((importId) => {
          process.stderr.write(`Document import started: importId=${importId}\n`);
        }),
    );
    return;
  }
  const root = await plan(options.path, skipped, failed);
  const conversionLoss: readonly string[] = [];
  if (root === null) {
    // The one path the caller named is itself unimportable; that is a failure of the whole
    // command, not a report with an empty middle.
    const only = failed[0] ?? skipped[0];
    throw new Error(
      only !== undefined
        ? `Cannot import ${only.path}: ${only.reason}`
        : `Cannot import ${options.path}.`,
    );
  }

  // Dynamic import: the parser is heavy, and the commands that never touch a body must not load
  // it. Each body is parsed exactly once - here for the preview, or in the write loop below right
  // before its item is created - so a file that cannot become a valid note is a reported failure
  // and its item is never made.
  const { markdownToDocument } = await import('@nix/markdown/from-markdown');

  if (options.dryRun) {
    const valid = validate(root, markdownToDocument, failed);
    writeResult({
      dryRun: true,
      workspaceId: options.workspaceId,
      parentId: options.parentId ?? null,
      planned: valid === null ? [] : flattenPlan(valid, []),
      skipped,
      failed,
      conversionLoss,
    });
    if (setExitCode && failed.length > 0) {
      process.exitCode = ExitCode.General;
    }
    return;
  }

  const session = await resolveSession(profileName, deps);
  const token = await session.tokens.getAccessToken();
  if (token === null) {
    throw new Error('Could not obtain a session for this profile.');
  }

  const { writeBodyMarkdown } = await import('../body.ts');
  const created: CreatedEntry[] = [];
  const notAttempted: SkippedEntry[] = [];
  let stoppedEarly = false;
  let stopReason: string | undefined;
  // Captured when the root itself is created, not read back as created[0]: the undo advice hangs
  // off this id, and a positional read would silently name the wrong item if anything were ever
  // created before the root.
  let rootItemId: string | null = null;

  // Parents before children, so a stop leaves a coherent partial tree: every created item hangs on
  // a created parent, and the report's `rootItemId` is the one handle that removes the whole
  // partial import (`nixctl item rm`). Drained with a head index rather than `shift()`, which
  // degrades sharply on queues past a few thousand entries - the width one flat folder can have.
  const queue: { entry: PlannedEntry; parentId: string | undefined }[] = [
    { entry: root, parentId: options.parentId },
  ];
  for (let head = 0; head < queue.length; head += 1) {
    const next = queue[head];
    if (next === undefined) {
      break;
    }

    // Parse before creating, so a file that cannot become a valid note fails on its own row and
    // no empty item is left standing for it. The parsed document is handed to the write, which is
    // the only time this body is parsed.
    let parsedDoc: unknown;
    let scan = next.entry.scan;
    if (next.entry.body.trim().length > 0) {
      const parsed = markdownToDocument(next.entry.body);
      if (!parsed.ok) {
        failed.push({ path: next.entry.path, reason: `not a valid note body: ${parsed.reason}` });
        for (const child of next.entry.children) {
          declineSubtree(child, 'its parent was not imported', notAttempted);
        }
        continue;
      }
      parsedDoc = parsed.doc;
      scan = parsed.scan;
    }

    let itemId: string;
    try {
      const item = await session.client.execute(
        items.createItem(options.workspaceId, {
          type: 'note',
          title: next.entry.title,
          ...(next.parentId !== undefined ? { parentId: next.parentId } : {}),
        }),
      );
      itemId = item.id;
      if (head === 0) {
        rootItemId = itemId;
      }
    } catch (error) {
      // Core's write rate limit is an expected outcome of importing a large tree, not a bug:
      // stop, keep what was made, list everything not attempted, and name the override. There is
      // no resume, so the honest advice is to remove the partial import before running again.
      if (isNixApiError(error) && error.status === 429) {
        stoppedEarly = true;
        stopReason =
          `Hit the write rate limit after ${String(created.length)} items. ` +
          `Remove the partial import (nixctl item rm <rootItemId>) and raise ${WRITES_LIMIT_OVERRIDE} on the stack before running again.`;
        declineSubtree(next.entry, 'stopped at the write rate limit', notAttempted);
        drainQueue(queue, head + 1, notAttempted);
        break;
      }
      // Anything else fails this entry - with the service's own words - and takes its subtree to
      // the not-attempted bucket: a child cannot be created under a parent that does not exist.
      failed.push({ path: next.entry.path, reason: toFailure(error).message });
      for (const child of next.entry.children) {
        declineSubtree(child, 'its parent was not imported', notAttempted);
      }
      continue;
    }

    const row: CreatedEntry = {
      path: next.entry.path,
      itemId,
      title: next.entry.title,
      properties: Object.keys(next.entry.properties),
      bodyBytes: 0,
      droppedFrontMatter: next.entry.droppedFrontMatter,
      unresolvedWikiLinks: scan.unresolvedWikiLinks,
      unresolvedObsidianEmbeds: scan.unresolvedObsidianEmbeds,
      unresolvedLocalImages: scan.unresolvedLocalImages,
      unsupportedImageAddresses: scan.unsupportedImageAddresses,
      inlineImagesFlattened: scan.inlineImagesFlattened,
    };
    created.push(row);

    // From here the item exists, so a refused body or property write is a loss declared on the
    // created row - never a "failure" that hides the id of what now sits in the workspace.
    if (parsedDoc !== undefined) {
      try {
        const written = await writeBodyMarkdown({
          collabUrl: session.endpoints.collabUrl,
          itemId,
          token,
          markdown: next.entry.body,
          parsed: { doc: parsedDoc, scan },
          // This item was created moments ago; its update log is empty, so the catch-up read
          // would fetch nothing. Skipping it halves the collab traffic of an import.
          assumeEmpty: true,
          ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        });
        row.bodyBytes = written.bytes;
      } catch (error) {
        row.bodyError = toFailure(error).message;
      }
    }

    if (row.properties.length > 0) {
      try {
        await session.client.execute(structure.setItemProperties(itemId, next.entry.properties));
      } catch (error) {
        if (isNixApiError(error) && error.status === 429) {
          stoppedEarly = true;
          stopReason =
            `Hit the write rate limit after ${String(created.length)} items. ` +
            `Remove the partial import (nixctl item rm <rootItemId>) and raise ${WRITES_LIMIT_OVERRIDE} on the stack before running again.`;
          row.propertiesError = toFailure(error).message;
          for (const child of next.entry.children) {
            declineSubtree(child, 'stopped at the write rate limit', notAttempted);
          }
          drainQueue(queue, head + 1, notAttempted);
          break;
        }
        row.propertiesError = toFailure(error).message;
      }
    }

    for (const child of next.entry.children) {
      queue.push({ entry: child, parentId: itemId });
    }
  }

  writeResult({
    workspaceId: options.workspaceId,
    parentId: options.parentId ?? null,
    rootItemId,
    created,
    skipped,
    failed,
    notAttempted,
    createdCount: created.length,
    stoppedEarly,
    conversionLoss,
    ...(stopReason !== undefined ? { reason: stopReason } : {}),
  });

  // The report goes out first, then the exit code says whether the import was whole: anything
  // failed, unattempted, or created-with-a-loss means a script must not read this as a success.
  const lossy = created.some(
    (entry) => entry.bodyError !== undefined || entry.propertiesError !== undefined,
  );
  if (setExitCode && (failed.length > 0 || notAttempted.length > 0 || stoppedEarly || lossy)) {
    process.exitCode = ExitCode.General;
  }
}

function asDocumentFormat(path: string): 'nix' | 'docx' | 'pdf' | 'txt' | null {
  const extension = extname(path).toLowerCase();
  if (extension === '.nix') return 'nix';
  if (extension === '.docx') return 'docx';
  if (extension === '.pdf') return 'pdf';
  if (extension === '.txt') return 'txt';
  return null;
}

async function runWorkerDocumentImport(
  profileName: string | undefined,
  options: ImportOptions,
  format: 'nix' | 'docx' | 'pdf' | 'txt',
  deps: SessionDeps,
  writeResult: (value: unknown) => void,
  onStarted?: (importId: string) => void,
): Promise<void> {
  const info = await stat(options.path);
  if (!info.isFile() || info.size > 100 * 1024 * 1024)
    throw new Error('The document must be a file no larger than 100 MiB.');
  const session = await resolveSession(profileName, deps);
  const title = basename(options.path, extname(options.path));
  let importId: string | null = null;
  try {
    const initiated = await session.client.execute(
      imports.beginDocumentImport({
        workspaceId: options.workspaceId,
        parentId: options.parentId ?? null,
        format,
        title,
        fileName: basename(options.path),
        mediaType: documentMediaType(format),
        byteLength: info.size,
        idempotencyKey: `cli-document:${crypto.randomUUID()}`,
      }),
    );
    importId = initiated.id;
    onStarted?.(importId);
    if (initiated.uploadUrl === null) {
      throw new Error('The import upload capability is no longer available.');
    }
    const uploadUrl = new URL(initiated.uploadUrl);
    if (
      uploadUrl.protocol !== 'https:' &&
      uploadUrl.hostname !== 'localhost' &&
      uploadUrl.hostname !== '127.0.0.1'
    ) {
      throw new Error('Object capabilities must use HTTPS outside local development.');
    }
    if (uploadUrl.username !== '' || uploadUrl.password !== '') {
      throw new Error('Object capabilities cannot contain URL credentials.');
    }
    const uploaded = await (deps.fetchImpl ?? globalThis.fetch)(uploadUrl.toString(), {
      method: 'PUT',
      body: createReadStream(options.path),
      headers: {
        'content-type': documentMediaType(format),
        'content-length': String(info.size),
      },
      duplex: 'half',
      redirect: 'error',
      credentials: 'omit',
    });
    if (!uploaded.ok) {
      throw new Error(`The document object upload was refused (${String(uploaded.status)}).`);
    }
    const previewJob = await session.client.execute(imports.previewDocumentImport(importId));
    if (options.noWait === true) {
      const durableImportId = importId;
      importId = null;
      writeResult({
        atomic: true,
        workspaceId: options.workspaceId,
        parentId: options.parentId ?? null,
        importId: durableImportId,
        operationId: previewJob.id,
        phase: 'preview',
        operationStatus: previewJob.status,
      });
      // The import is durable and intentionally remains available for get/commit/cancel.
      return;
    }
    await operations.waitForOperation(session.client, previewJob.id);
    const preview = await session.client.query(imports.documentImportById(importId), {
      forceRefresh: true,
    });
    if (preview.status !== 'preview_ready') {
      throw new Error(preview.failureCode ?? 'The document preview did not become ready.');
    }
    const previewPlan = await imports.fetchDocumentImportPlan(session.client, importId);
    const mapping = previewPlan.items.map((item) => ({
      sourceId: item.sourceId,
      parentSourceId: item.parentSourceId,
      title: item.title,
      itemType: item.itemType,
      lifecycleState: item.finalLifecycleState,
      file:
        item.file === undefined
          ? null
          : {
              name: item.file.fileName,
              mediaType: item.file.mediaType,
              bytes: item.file.byteLength,
              source: item.file.sourceKind,
            },
    }));

    if (options.dryRun) {
      writeResult({
        dryRun: true,
        atomic: true,
        workspaceId: options.workspaceId,
        parentId: options.parentId ?? null,
        importId,
        planned: mapping,
        loss: preview.loss ?? previewPlan.loss,
        omissions: preview.omissions ?? previewPlan.omissions,
      });
      await session.client.execute(imports.cancelDocumentImport(importId));
      importId = null;
      return;
    }

    const completed = await imports.commitAndWaitDocumentImport(session.client, importId);
    writeResult({
      atomic: true,
      workspaceId: options.workspaceId,
      parentId: options.parentId ?? null,
      importId,
      rootItemId: completed.rootItemId,
      createdCount: completed.itemCount ?? mapping.length,
      assetCount: completed.assetCount ?? 0,
      created: mapping,
      loss: completed.loss ?? previewPlan.loss,
      omissions: completed.omissions ?? previewPlan.omissions,
      status: completed.status,
    });
    importId = null;
  } catch (error) {
    if (importId !== null) {
      await session.client.execute(imports.cancelDocumentImport(importId)).catch(() => undefined);
    }
    throw error;
  }
}

function documentMediaType(format: 'nix' | 'docx' | 'pdf' | 'txt'): string {
  if (format === 'pdf') return 'application/pdf';
  if (format === 'txt') return 'text/plain';
  if (format === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  return 'application/vnd.nix.archive';
}

/** Declares an entry and its whole subtree as not attempted, with the reason. */
function declineSubtree(entry: PlannedEntry, reason: string, into: SkippedEntry[]): void {
  into.push({ path: entry.path, reason });
  for (const child of entry.children) {
    declineSubtree(child, reason, into);
  }
}

/** Declares everything still queued from `from` onward as not attempted. */
function drainQueue(
  queue: readonly { entry: PlannedEntry }[],
  from: number,
  into: SkippedEntry[],
): void {
  for (let index = from; index < queue.length; index += 1) {
    const waiting = queue[index];
    if (waiting !== undefined) {
      declineSubtree(waiting.entry, 'stopped at the write rate limit', into);
    }
  }
}

/**
 * Walks the source path into a planned tree, deciding titles and front matter without touching the
 * network. Anything the walk cannot import lands in `skipped` with its reason - a non-Markdown
 * file, a hidden directory, a symbolic link (not followed, so a cycle cannot make the walk
 * infinite) - never dropped silently. The named root is the one place a symlink is followed: the
 * caller pointed at it, so following it is the request, not a traversal surprise.
 */
async function plan(
  path: string,
  skipped: SkippedEntry[],
  failed: FailedEntry[],
): Promise<PlannedEntry | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    failed.push({ path, reason: 'not found or not readable' });
    return null;
  }

  if (info.isDirectory()) {
    let entries;
    try {
      entries = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
        compareCodeUnits(a.name, b.name),
      );
    } catch {
      failed.push({ path, reason: 'not readable' });
      return null;
    }
    const children: PlannedEntry[] = [];
    for (const entry of entries) {
      const childPath = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ path: childPath, reason: 'symbolic link, not followed' });
        continue;
      }
      if (entry.isDirectory()) {
        // `.obsidian`, `.git`, `.trash`: a dot-directory is a tool's private space, not part of
        // the work being brought in. Skipped as a whole, with its reason, rather than imported as
        // a container full of file-by-file skips.
        if (entry.name.startsWith('.')) {
          skipped.push({ path: childPath, reason: 'hidden directory, not imported' });
          continue;
        }
        const child = await plan(childPath, skipped, failed);
        if (child !== null) {
          children.push(child);
        }
        continue;
      }
      if (extname(entry.name).toLowerCase() !== '.md') {
        skipped.push({ path: childPath, reason: 'not a Markdown file' });
        continue;
      }
      const file = await planFile(childPath, failed);
      if (file !== null) {
        children.push(file);
      }
    }
    return {
      path,
      kind: 'container',
      title: basename(path),
      properties: {},
      body: '',
      droppedFrontMatter: [],
      scan: EMPTY_MARKDOWN_IMPORT_SCAN,
      children,
    };
  }

  if (extname(path).toLowerCase() !== '.md') {
    skipped.push({ path, reason: 'not a Markdown file' });
    return null;
  }
  return planFile(path, failed);
}

/** Reads one Markdown file into a planned note: front matter split off, title decided. */
async function planFile(path: string, failed: FailedEntry[]): Promise<PlannedEntry | null> {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    failed.push({ path, reason: 'not readable' });
    return null;
  }

  const { title, properties, body, dropped } = noteFromMarkdown(text, basename(path));

  return {
    path,
    kind: 'note',
    title,
    properties,
    body,
    droppedFrontMatter: dropped,
    scan: EMPTY_MARKDOWN_IMPORT_SCAN,
    children: [],
  };
}

/**
 * Gates every planned body through the parser, for the dry run's report: a failed child is pruned
 * into `failed`, a failed root fails the plan. The real run parses per entry instead, right before
 * each create, so nothing is parsed twice.
 */
function validate(
  entry: PlannedEntry,
  parse: (markdown: string) => FromMarkdownResult,
  failed: FailedEntry[],
): PlannedEntry | null {
  let scan = entry.scan;
  if (entry.body.trim().length > 0) {
    const parsed = parse(entry.body);
    if (!parsed.ok) {
      failed.push({ path: entry.path, reason: `not a valid note body: ${parsed.reason}` });
      return null;
    }
    scan = parsed.scan;
  }

  const children: PlannedEntry[] = [];
  for (const child of entry.children) {
    const kept = validate(child, parse, failed);
    if (kept !== null) {
      children.push(kept);
    }
  }
  return { ...entry, scan, children };
}

interface PlannedRow {
  readonly path: string;
  readonly kind: string;
  readonly title: string;
  readonly properties: readonly string[];
  /** The UTF-8 length of the Markdown source - not the write's delta, which only a real run has. */
  readonly sourceBytes: number;
  readonly droppedFrontMatter: readonly string[];
  readonly unresolvedWikiLinks: number;
  readonly unresolvedObsidianEmbeds: number;
  readonly unresolvedLocalImages: number;
  readonly unsupportedImageAddresses: number;
  readonly inlineImagesFlattened: number;
}

/** The planned tree as a flat list for the dry-run report, parents before children. */
function flattenPlan(entry: PlannedEntry, into: PlannedRow[]): PlannedRow[] {
  into.push({
    path: entry.path,
    kind: entry.kind,
    title: entry.title,
    properties: Object.keys(entry.properties),
    sourceBytes: Buffer.byteLength(entry.body.trim(), 'utf8'),
    droppedFrontMatter: entry.droppedFrontMatter,
    unresolvedWikiLinks: entry.scan.unresolvedWikiLinks,
    unresolvedObsidianEmbeds: entry.scan.unresolvedObsidianEmbeds,
    unresolvedLocalImages: entry.scan.unresolvedLocalImages,
    unsupportedImageAddresses: entry.scan.unsupportedImageAddresses,
    inlineImagesFlattened: entry.scan.inlineImagesFlattened,
  });
  for (const child of entry.children) {
    flattenPlan(child, into);
  }
  return into;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
