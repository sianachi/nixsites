import type { PetToolCall } from '@nix/api-client';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';

export type BuildLedger = readonly { nodeId: string; itemId?: string; status?: string }[];

export interface BuildOutcome {
  complete: boolean;
  rootId: string | null;
  ledger: readonly { nodeId: string; itemId?: string; status: string }[];
}

export const DECLINED_BY_USER = 'Declined by the user. Do not retry this change unless asked.';
/** The receipt of an approved write that was refused before it changed anything, with the
 * owner's reason kept beside it (`ownerReasons`) rather than the model's. */
export const NOT_RUN = 'Not run - nothing changed';

/** A settled body edit's one-line receipt, which is never previewed again (see the card's
 * preview effect): what it was, without claiming what the note says now. */
export function settledBodyEditHeadline(args: WorkspaceToolArgs): string {
  const heading = args.query
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = heading.length > 40 ? `${heading.slice(0, 39).trimEnd()}…` : heading;
  return args.operation === 'replace_section'
    ? `Edit to the section “${name}” in the linked note`
    : 'Edit to one passage in the linked note';
}
/** Receipts for a write the owner's "Apply without asking" switch ran (lane F). Stored like
 * every other receipt, so the wording survives closing and reopening the panel, and read back
 * by `ranWithoutAsking` so no card has to remember it. */
export const APPLYING_WITHOUT_ASKING = 'Applying without asking…';
export const DONE_WITHOUT_ASKING = 'Done without asking';
export const WITHOUT_ASKING_SUFFIX = ' Ran without asking.';

export function ranWithoutAsking(submitted: string | undefined): boolean {
  return (
    submitted === APPLYING_WITHOUT_ASKING ||
    submitted === DONE_WITHOUT_ASKING ||
    (submitted?.endsWith(WITHOUT_ASKING_SUFFIX) ?? false)
  );
}
export const DECLINED_FOR_PROBLEMS_PREFIX = 'Declined: the design has problems.';

export function buildOutcome(text: string): BuildOutcome | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.complete !== 'boolean' ||
      !(candidate.rootId === null || typeof candidate.rootId === 'string') ||
      !Array.isArray(candidate.ledger) ||
      !candidate.ledger.every((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const ledgerEntry = entry as Record<string, unknown>;
        return (
          typeof ledgerEntry.nodeId === 'string' &&
          typeof ledgerEntry.status === 'string' &&
          (ledgerEntry.itemId === undefined || typeof ledgerEntry.itemId === 'string')
        );
      })
    )
      return undefined;
    return candidate as unknown as BuildOutcome;
  } catch {
    return undefined;
  }
}

/** The one sentence worth speaking when the newest tool call ended badly: a build that stopped
 * part way, or a write that did not finish. A clean finish and a decline say nothing. */
export function toolOutcomeSentence(tool: PetToolCall | undefined): string {
  if (!tool) return '';
  if (tool.status === 'completed') {
    const build = buildOutcome(tool.result);
    if (!build || build.complete) return '';
    const done = build.ledger.filter((entry) => entry.status === 'done').length;
    return `Stopped after ${String(done)} of ${String(build.ledger.length)}. The draft is incomplete.`;
  }
  return tool.status === 'failed' && tool.result !== DECLINED_BY_USER && tool.result !== NOT_RUN
    ? "Didn't finish. Check your workspace before retrying."
    : '';
}

/** A request's headline said what the pet would do ("I will create a note ... with the content
 * shown below"); once it has run, the receipt names the same request in the imperative and lets
 * the status word carry the outcome. Nothing below a receipt promises text that is not there. */
export function receiptSentence(headline: string): string {
  if (!headline.startsWith('I will ')) return headline;
  const request = headline
    .slice('I will '.length)
    .replace(/, with the content shown below(?=\.)/, '')
    .replace(/ with the property values shown below(?=,)/, '')
    .replace('the content below', 'content');
  return request.charAt(0).toUpperCase() + request.slice(1);
}
