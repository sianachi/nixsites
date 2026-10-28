import { z } from 'zod';

/**
 * What the installed app was launched to do - from a home-screen or dock shortcut, a share sheet,
 * or a Markdown file opened with Nix - read from the launch address the manifest names.
 *
 * Everything here arrives from outside the app (another application's share sheet writes the
 * query), so it is parsed and bounded rather than trusted: an unknown action is no action, and
 * shared text is capped well inside what one note body may hold.
 */
export type LaunchIntent =
  | { readonly kind: 'new' }
  | { readonly kind: 'today' }
  | { readonly kind: 'search' }
  | { readonly kind: 'open' }
  | {
      readonly kind: 'share';
      readonly title: string;
      readonly text: string;
      readonly url: string | null;
    };

/** Shared text beyond this is cut rather than refused: a share sheet cannot be asked to retry. */
export const MAX_SHARED_TEXT = 100_000;
const MAX_SHARED_TITLE = 500;

const httpUrl = z
  .url({ protocol: /^https?$/u })
  .max(4_096)
  .nullable()
  .catch(null);

export function parseLaunchIntent(
  action: string | undefined,
  search: URLSearchParams,
): LaunchIntent | null {
  switch (action) {
    case 'new':
    case 'today':
    case 'search':
    case 'open':
      return { kind: action };
    case 'share': {
      const text = (search.get('text') ?? '').slice(0, MAX_SHARED_TEXT).trim();
      const title = (search.get('title') ?? '').slice(0, MAX_SHARED_TITLE).trim();
      const url = httpUrl.parse(search.get('url'));
      if (text === '' && title === '' && url === null) return null;
      return { kind: 'share', title, text, url };
    }
    default:
      return null;
  }
}

/** What `AppShell` reads from navigation state to open search over whatever is showing. */
export interface LaunchNavigationState {
  readonly openSearch?: boolean;
}

/** The query parameters a share launch carries, kept when the launch is routed into a workspace. */
export const SHARE_PARAMETERS = ['title', 'text', 'url'] as const;

/**
 * The title a shared note gets: the one the sharing app gave, else the first line of the text,
 * else the link's host - something a person will recognise in the tree later.
 */
export function sharedNoteTitle(intent: Extract<LaunchIntent, { kind: 'share' }>): string {
  if (intent.title !== '') return intent.title;
  const firstLine = intent.text.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  if (firstLine !== '') return firstLine.slice(0, 120);
  return intent.url === null ? 'Shared note' : new URL(intent.url).host;
}

/**
 * The shared content as a document: the text as plain paragraphs, then the link on its own line
 * unless the text already carries it - several share sheets put the address in both.
 *
 * **Plain text, deliberately not Markdown.** The share target is reachable by any page that can
 * link someone to it, so what arrives is text somebody else chose. Read as Markdown it could carry
 * images that load from a stranger's server every time a colleague opens the note, or links whose
 * text disguises where they go. As plain text it is exactly what was shared and nothing more: the
 * one link is the address itself, shown as itself.
 */
export function sharedNoteDocument(intent: Extract<LaunchIntent, { kind: 'share' }>): unknown {
  const paragraphs = intent.text === '' ? [] : intent.text.split(/\r?\n/u).map(paragraph);
  if (intent.url !== null && !intent.text.includes(intent.url)) {
    paragraphs.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: intent.url, marks: [{ type: 'link', attrs: { href: intent.url } }] },
      ],
    });
  }
  return { type: 'doc', content: paragraphs.length === 0 ? [{ type: 'paragraph' }] : paragraphs };
}

function paragraph(line: string): unknown {
  return line === ''
    ? { type: 'paragraph' }
    : { type: 'paragraph', content: [{ type: 'text', text: line }] };
}
