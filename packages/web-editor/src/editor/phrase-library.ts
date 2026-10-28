import * as Y from 'yjs';

import { NgramModel } from '@nix/web-foundation/lib/suggest/ngram';
import {
  bodyCacheAdmits,
  listBodyCacheScopes,
  onBodyForgetting,
  readBodyCache,
  type BodyForgetting,
} from '@nix/web-foundation/lib/body-cache';
import { FRAGMENT_NAME } from './collab-sync';

/**
 * What the phrase suggestions have learned from notes other than the one being written: one small
 * n-gram model per body, held in memory for this page's lifetime and never written anywhere.
 *
 * **Two ways in, both through the body cache's own rules.** A note closed in this session hands
 * over its text if its editor was allowed to keep a local copy (`learnBody`) - the same permission
 * the body cache asks for, so a password-locked body is never learned, even while unlocked. And on
 * idle, copies the cache already holds for this workspace are decoded and learned
 * (`warmPhraseLibrary`), read through `readBodyCache` with every check it applies: the right
 * person, not sealed, within age and size.
 *
 * **Forgetting follows the cache exactly.** A model per body, rather than one merged model,
 * because counts cannot be un-summed: when the cache forgets a body - revoked, locked, its
 * workspace gone, sign-out - this drops that body's model and nothing else has to be recomputed.
 * The cache announces every forgetting (`onBodyForgetting`) before touching the disk, so memory is
 * cleared even if IndexedDB refuses.
 *
 * **One workspace at a time.** Models are offered only to editors in the workspace and for the
 * person they were learned in. A phrase from one workspace's notes never appears as a suggestion
 * in another - the same separation the frecency namespaces keep.
 *
 * **Decoding without the editor.** A cached copy is a Yjs update. Applying it to a bare `Y.Doc`
 * and reading the text out of the XML fragment needs no ProseMirror schema and no editor, and is
 * bounded below by `MAX_DECODE_BYTES` and one body per idle callback.
 */

/** The most bodies held at once; the oldest learned is dropped past it. */
export const MAX_LIBRARY_BODIES = 20;

/** Each body model's bound on distinct counts. Twenty of these is about 100k counts in all. */
export const BODY_MODEL_ENTRIES = 5_000;

/** The most text learned from one body, in characters. The rest of a very long note is skipped. */
export const MAX_BODY_CHARS = 100_000;

/** Cached copies larger than this are not decoded on idle: the decode would be a long task. */
export const MAX_DECODE_BYTES = 512 * 1024;

interface LearnedBody {
  readonly subject: string;
  readonly workspaceId: string;
  readonly model: NgramModel;
}

/** By body scope. A `Map` keeps insertion order, which is learning order, for eviction. */
const library = new Map<string, LearnedBody>();

/** `subject + workspace` pairs whose cached copies have been (or are being) read this session. */
const warmed = new Set<string>();

function parseScope(scope: string): { subject: string; workspaceId: string } | null {
  try {
    const parsed: unknown = JSON.parse(scope);
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[0].length > 0 &&
      parsed[1].length > 0
    ) {
      return { subject: parsed[0], workspaceId: parsed[1] };
    }
  } catch {
    // Not a scope this module wrote; it is ignored.
  }
  return null;
}

/**
 * Bumped by every forgetting, so a body read before one and decoded after it is not learned: the
 * read raced the forgetting, and the forgetting wins.
 */
let generation = 0;

function forget(forgetting: BodyForgetting): void {
  generation += 1;
  switch (forgetting.kind) {
    case 'everything':
      library.clear();
      warmed.clear();
      return;
    case 'scope':
      library.delete(forgetting.scope);
      return;
    case 'item':
      for (const scope of [...library.keys()]) {
        if (scope.startsWith(forgetting.prefix)) library.delete(scope);
      }
      return;
    case 'unreachable':
      for (const [scope, body] of [...library]) {
        if (
          body.subject !== forgetting.subject ||
          !forgetting.reachableWorkspaceIds.has(body.workspaceId)
        ) {
          library.delete(scope);
        }
      }
      return;
  }
}

// Subscribed for the page's lifetime: the library lives exactly as long as this module does.
onBodyForgetting(forget);

/**
 * Learns one body's text under its scope, replacing anything learned from it before.
 *
 * Refused unless the body cache would admit the same scope right now. A caller passes only bodies
 * it would be allowed to cache; this check is the backstop for a lock or sign-out that happened
 * while the editor was open.
 */
export function learnBody(scope: string, text: string): void {
  const owner = parseScope(scope);
  if (owner === null || !bodyCacheAdmits(scope)) {
    return;
  }
  const model = new NgramModel(BODY_MODEL_ENTRIES);
  model.train(text.slice(0, MAX_BODY_CHARS));
  library.delete(scope);
  if (model.size === 0) {
    return;
  }
  library.set(scope, { ...owner, model });
  while (library.size > MAX_LIBRARY_BODIES) {
    const oldest = library.keys().next().value;
    if (oldest === undefined) break;
    library.delete(oldest);
  }
}

/** The models learned for this person in this workspace, except the body being edited. */
export function libraryModels(subject: string, workspaceId: string, except?: string): NgramModel[] {
  const models: NgramModel[] = [];
  for (const [scope, body] of library) {
    if (
      scope !== except &&
      body.subject === subject &&
      body.workspaceId === workspaceId &&
      bodyCacheAdmits(scope)
    ) {
      models.push(body.model);
    }
  }
  return models;
}

/** Empties the library. For tests, which share a module registry. */
export function resetPhraseLibrary(): void {
  library.clear();
  warmed.clear();
}

/**
 * The prose text of a body's Yjs state: every text run, a line break after every element, code
 * blocks left out. No schema involved - the XML fragment is read as Yjs stores it.
 *
 * Exported for its own tests.
 */
export function proseTextOfUpdate(update: Uint8Array, maxChars: number = MAX_BODY_CHARS): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    const out: string[] = [];
    let length = 0;
    const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
      if (length >= maxChars) return;
      if (node instanceof Y.XmlText) {
        for (const op of node.toDelta() as readonly { insert?: unknown }[]) {
          if (typeof op.insert === 'string') {
            out.push(op.insert);
            length += op.insert.length;
          }
        }
        return;
      }
      if (node instanceof Y.XmlElement && node.nodeName === 'codeBlock') {
        // Code is not prose; learning it would offer identifiers as English.
        out.push('\n');
        return;
      }
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
      }
      if (node instanceof Y.XmlElement) {
        out.push('\n');
        length += 1;
      }
    };
    visit(doc.getXmlFragment(FRAGMENT_NAME));
    return out.join('').slice(0, maxChars);
  } finally {
    doc.destroy();
  }
}

/** Runs `work` when the browser is idle, or soon, where idle callbacks are unavailable. */
function whenIdle(work: () => void): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(work, { timeout: 5_000 });
  } else {
    setTimeout(work, 200);
  }
}

/**
 * Learns, on idle and one body at a time, the copies the body cache holds for this person in this
 * workspace - the most recent `MAX_LIBRARY_BODIES` - skipping the body being edited.
 *
 * Once per workspace per session (until sign-out clears the library). Quietly does nothing where
 * there is no IndexedDB or the cache refuses: suggestions then come from this session's notes.
 */
export function warmPhraseLibrary(
  subject: string,
  workspaceId: string,
  except: string | undefined,
  signal: AbortSignal,
): void {
  const key = JSON.stringify([subject, workspaceId]);
  if (warmed.has(key) || typeof indexedDB === 'undefined') {
    return;
  }
  warmed.add(key);

  void (async () => {
    let scopes: string[];
    try {
      scopes = await listBodyCacheScopes(subject, workspaceId, MAX_LIBRARY_BODIES);
    } catch {
      warmed.delete(key);
      return;
    }
    // Oldest first, so the most recent copies are learned last and survive eviction longest.
    const queue = scopes.filter((scope) => scope !== except && !library.has(scope)).reverse();

    const step = (): void => {
      if (signal.aborted) {
        // Another editor in this workspace may start it again.
        warmed.delete(key);
        return;
      }
      const scope = queue.shift();
      if (scope === undefined) return;
      void (async () => {
        try {
          const before = generation;
          const record = await readBodyCache(scope);
          if (
            record !== null &&
            record.update.byteLength <= MAX_DECODE_BYTES &&
            !signal.aborted &&
            generation === before &&
            !library.has(scope)
          ) {
            learnBody(scope, proseTextOfUpdate(record.update));
          }
        } catch {
          // An unreadable copy is skipped; it teaches nothing either way.
        }
        whenIdle(step);
      })();
    };
    whenIdle(step);
  })();
}
