import type { PetToolCall } from '@nix/api-client';
import type { WorkspaceToolArgs } from '@nix/companion/tool-args';
import { DECLINED_BY_USER } from './receipts';

/** The base (infinitive), progressive and past forms of one read's sentence
 * (UX fix U3): "Search for "x"?" while pending, "Searching for "x"" while running, "Searched for
 * "x"" once done. `base` also backs the declined/failed forms - see `describeReadSentence`. */
interface ReadPhrase {
  base: string;
  progressive: string;
  past: string;
}

function readPhrase(args: WorkspaceToolArgs): ReadPhrase {
  switch (args.operation) {
    case 'list_items':
      return { base: 'List items', progressive: 'Listing items', past: 'Listed items' };
    case 'search': {
      const target = args.query ? `for "${args.query}"` : 'the workspace';
      return {
        base: `Search ${target}`,
        progressive: `Searching ${target}`,
        past: `Searched ${target}`,
      };
    }
    case 'read_item':
      return { base: 'Read an item', progressive: 'Reading an item', past: 'Read an item' };
    case 'read_note':
      return { base: 'Read a note', progressive: 'Reading a note', past: 'Read a note' };
    case 'read_view':
      return { base: 'Read a view', progressive: 'Reading a view', past: 'Read a view' };
    case 'read_structure':
      return {
        base: "Read an item's structure",
        progressive: "Reading an item's structure",
        past: "Read an item's structure",
      };
    case 'list_templates':
      return {
        base: 'List templates',
        progressive: 'Listing templates',
        past: 'Listed templates',
      };
    case 'read_template':
      return {
        base: 'Read a template',
        progressive: 'Reading a template',
        past: 'Read a template',
      };
    case 'read_calendar': {
      const range = calendarRangeLabel(args.specJson);
      return {
        base: `Read the calendar${range}`,
        progressive: `Reading the calendar${range}`,
        past: `Read the calendar${range}`,
      };
    }
    default:
      return {
        base: 'Run a read-only request',
        progressive: 'Running a read-only request',
        past: 'Ran a read-only request',
      };
  }
}

/** " from 2026-10-05 to 2026-10-11" for a calendar read's sentence, or nothing when its range
 * cannot be read (the read itself then refuses with the reason). */
function calendarRangeLabel(specJson: string): string {
  try {
    const range = JSON.parse(specJson) as { from?: unknown; to?: unknown };
    return typeof range.from === 'string' && typeof range.to === 'string'
      ? ` from ${range.from} to ${range.to}`
      : '';
  } catch {
    return '';
  }
}

function lowerFirst(text: string): string {
  return text.length ? `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}` : text;
}

/** The one-line sentence a read is announced by, shaped by its status (UX
 * fix U3): a question while it waits for approval, present-progressive while it runs, past tense
 * once it is done, and "Didn't"/"Couldn't" once it is declined or failed - the same five-way
 * pattern for every read operation. */
export function describeReadSentence(
  tool: PetToolCall,
  args: WorkspaceToolArgs,
  autoRun: boolean,
): string {
  const phrase = readPhrase(args);
  if (tool.status === 'pending') {
    // An auto-run read is never actually waiting on the owner, even while the server has not
    // yet turned its status to "claimed" - see `readStatusText`'s own note on the same race.
    return autoRun ? phrase.progressive : `${phrase.base}?`;
  }
  if (tool.status === 'claimed') return phrase.progressive;
  if (tool.status === 'completed') return phrase.past;
  if (tool.status === 'failed' && tool.result === DECLINED_BY_USER)
    return `Didn't ${lowerFirst(phrase.base)}`;
  return `Couldn't ${lowerFirst(phrase.base)}`;
}

export function readStatusText(
  tool: PetToolCall,
  autoRun: boolean,
  submitted: string | undefined,
): string {
  if (tool.status === 'pending') {
    // An auto-run keeps its own running label even once its (identical, internal) submission
    // receipt exists - that receipt is bookkeeping against a repeat prompt, not something the
    // owner asked for, so it never gets to say so on their behalf.
    if (autoRun) return 'Running…';
    if (submitted) return submitted;
    return 'Waiting for your approval';
  }
  if (tool.status === 'claimed') return 'Running…';
  if (tool.status === 'completed') return 'Done';
  if (tool.status === 'failed') return tool.result === DECLINED_BY_USER ? 'Declined' : 'Failed';
  return 'Stopped';
}
