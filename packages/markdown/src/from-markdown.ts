/**
 * Direction 2: Markdown parsed back into a ProseMirror document body, as plain JSON.
 *
 * **Built on `prosemirror-markdown`'s `MarkdownParser` against the real `nixSchema`, then gated
 * through `parseDocument`.** markdown-it tokenises, the parser maps its tokens onto Nix's own node
 * names, and a short post-pass rebuilds the custom constructs `documentToMarkdown` emits with a
 * plain-Markdown spelling - a `nix://` link back into a reference node, a `[!tone]` blockquote back
 * into a callout, and a GFM pipe grid back into a table. Anything the round trip cannot rebuild
 * degrades to the nearest standard node rather than failing, and the final document is always
 * validated: an input that would produce a body the schema rejects returns `{ ok: false }` with
 * the reason, never a silently broken doc.
 *
 * A column layout still does not come back as itself: it is written as its nearest Markdown form. GFM tables import with rows, cells, alignment and inline
 * marks. Exporting a richer Nix table first may already have changed its header roles, merged-cell
 * geometry, column widths, per-cell alignment, cell blocks and marks; those remain the table's
 * declared losses.
 */

import MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import { MarkdownParser, type ParseSpec } from 'prosemirror-markdown';
import {
  isAllowedLinkAddress,
  nixSchema,
  parseDocument,
  REFERENCE_KINDS,
} from '@nix/editor-schema';
import { countRawSyntax } from './raw-syntax.js';
import { isLocalImageTarget, isPersistableImageTarget, type MarkdownImportScan } from './scan.js';

export type FromMarkdownResult =
  | {
      readonly ok: true;
      readonly doc: unknown;
      readonly scan: MarkdownImportScan;
      /** Filesystem image targets the importer can match to selected attachments. */
      readonly localImageTargets?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface MutableMarkdownImportScan {
  unresolvedWikiLinks: number;
  unresolvedObsidianEmbeds: number;
  unresolvedLocalImages: number;
  unsupportedImageAddresses: number;
  inlineImagesFlattened: number;
}

interface MarkdownEnvironment {
  readonly importScan: MutableMarkdownImportScan;
  readonly localImageTargets: string[];
  readonly obsidianBoundaries: Map<string, ObsidianBoundaries>;
  references?: Record<string, { href: string; title: string }>;
}

interface ObsidianBoundaries {
  readonly closes: readonly number[];
  readonly newlines: readonly number[];
}

/** The minimal shape of a ProseMirror node in its JSON form, for the post-pass. */
interface JsonNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

// GFM-ish: strikethrough and pipe tables are on; HTML is off so a stray tag is escaped text rather
// than an injected node the schema has no home for. The details block is flattened before parsing;
// image placement and import observations are handled by token rules below.
const tokenizer = MarkdownIt('commonmark', { html: false, linkify: true }).enable([
  'strikethrough',
  'table',
  'linkify',
]);
// Only an explicit scheme (https://, mailto:) becomes a link: fuzzy matching would turn a file name
// like `notes.md` (.md is a country domain) into one.
tokenizer.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });

// `<br>` is the one tag a model writes for a line break; every other tag stays escaped text.
tokenizer.inline.ruler.before('text', 'nix_br', (state, silent) => {
  const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos, state.pos + 8));
  if (match === null) {
    return false;
  }
  if (!silent) {
    state.push('hardbreak', 'br', 0);
  }
  state.pos += match[0].length;
  return true;
});

// `**text**` is bold whenever its inside neither starts nor ends with whitespace, whatever surrounds
// it (`**Note:**text`, `**"hi"**there`), which CommonMark's flanking rules refuse next to
// punctuation. Content holding another `*` is left to the standard emphasis rule.
tokenizer.inline.ruler.before('emphasis', 'nix_strong', (state, silent) => {
  const { src, pos } = state;
  if (!src.startsWith('**', pos) || src[pos + 2] === '*' || (pos > 0 && src[pos - 1] === '*')) {
    return false;
  }
  const end = src.indexOf('**', pos + 2);
  if (end === -1 || end > state.posMax - 2) {
    return false;
  }
  const inside = src.slice(pos + 2, end);
  if (inside.length === 0 || /^\s|\s$|[*\n`[<]/.test(inside) || src[end + 2] === '*') {
    return false;
  }
  if (!silent) {
    const inner: Token[] = [];
    state.md.inline.parse(inside, state.md, state.env, inner);
    state.push('strong_open', 'strong', 1);
    state.tokens.push(...inner);
    state.push('strong_close', 'strong', -1);
  }
  state.pos = end + 2;
  return true;
});

// A list whose items all start with `[ ]` or `[x]` is a task list. Runs last so the `[` `]` text
// pieces have been joined into one text token.
const TASK_BOX = /^\[([ xX])\](?:\s+|$)/;
tokenizer.core.ruler.after('text_join', 'nix_task_lists', (state) => {
  const all = state.tokens;
  for (let index = 0; index < all.length; index += 1) {
    const open = all[index];
    if (open?.type !== 'bullet_list_open') {
      continue;
    }
    const items: number[] = [];
    let close = index + 1;
    while (close < all.length) {
      const token = all[close];
      if (token?.type === 'bullet_list_close' && token.level === open.level) {
        break;
      }
      if (token?.type === 'list_item_open' && token.level === open.level + 1) {
        items.push(close);
      }
      close += 1;
    }
    const inlines = items.map((item) => all[item + 2]);
    if (
      items.length === 0 ||
      !inlines.every((inline) => inline?.type === 'inline' && TASK_BOX.test(inline.content))
    ) {
      continue;
    }
    open.type = 'task_list_open';
    const closing = all[close];
    if (closing !== undefined) {
      closing.type = 'task_list_close';
    }
    items.forEach((item, at) => {
      const inline = inlines[at];
      const itemOpen = all[item];
      const checked = inline !== undefined && /^\[[xX]]/.test(inline.content);
      itemOpen?.attrSet('checked', checked ? 'true' : 'false');
      if (itemOpen !== undefined) {
        itemOpen.type = 'task_item_open';
      }
      if (inline !== undefined) {
        inline.content = inline.content.replace(TASK_BOX, '');
        const first = inline.children?.[0];
        if (first?.type === 'text') {
          first.content = first.content.replace(TASK_BOX, '');
        }
      }
      for (let end = item; end < close; end += 1) {
        const token = all[end];
        if (token?.type === 'list_item_close' && token.level === open.level + 1) {
          token.type = 'task_item_close';
          break;
        }
      }
    });
  }
});

// markdown-it intentionally refuses file-scheme images before emitting an image token. Recognise
// that one rejected filesystem spelling here so the exact literal remains visible and the import
// report still declares it. Returning false during label validation preserves any outer link.
const FILE_IMAGE =
  /^!\[[^\]\n]*]\(\s*(?:<file:[^>\n]+>|file:[^\s)\n]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/i;

tokenizer.inline.ruler.before('text', 'nix_file_images', (state, silent) => {
  if (silent || !state.src.startsWith('![', state.pos)) {
    return false;
  }
  const match = FILE_IMAGE.exec(state.src.slice(state.pos));
  const source = match?.[0];
  if (source === undefined) {
    return false;
  }

  const environment = state.env as MarkdownEnvironment;
  environment.importScan.unresolvedLocalImages += 1;
  const token = state.push('text', '', 0);
  token.content = source;
  state.pos += source.length;
  return true;
});

// Recognise Obsidian references as their own inline spelling. They deliberately remain text: the
// importer has no item ids with which to resolve a wiki link and no file bytes with which to
// resolve an embed. Owning the count in the tokenizer makes code spans/fences and escaped brackets
// immune to false reports, and makes `![[...]]` mutually exclusive with `[[...]]`.
tokenizer.inline.ruler.before('text', 'nix_obsidian_references', (state, silent) => {
  const start = state.pos;
  const embed = state.src.startsWith('![[', start);
  const wiki = !embed && state.src.startsWith('[[', start);
  if (!embed && !wiki) {
    return false;
  }
  if (silent) {
    return false;
  }

  // `\![[target]]` is literal source, not an embed followed by a wiki link. The escape rule has
  // already consumed the escaped bang by the time inline parsing reaches the first bracket.
  if (wiki && start > 0 && state.src[start - 1] === '!' && isEscaped(state.src, start - 1)) {
    return false;
  }

  const contentStart = start + (embed ? 3 : 2);
  const environment = state.env as MarkdownEnvironment;
  const boundaries = obsidianBoundaries(environment, state.src);
  const end = firstAtOrAfter(boundaries.closes, contentStart);
  const newline = firstAtOrAfter(boundaries.newlines, contentStart);
  if (end === undefined || end === contentStart || (newline !== undefined && newline < end)) {
    return false;
  }
  state.pos = end + 2;

  if (embed) {
    environment.importScan.unresolvedObsidianEmbeds += 1;
  } else {
    environment.importScan.unresolvedWikiLinks += 1;
  }
  const token = state.push('text', '', 0);
  token.content = state.src.slice(start, end + 2);
  return true;
});

// Rewrite images after inline parsing, when code and CommonMark destinations are known. A durable
// web/data image that occupies a root paragraph keeps the block-image behaviour Markdown already
// had. Other images become links or readable source text. Filesystem and ambiguous addresses never
// become browser-relative or unsupported image requests.
tokenizer.core.ruler.after('inline', 'nix_import_images', (state) => {
  const environment = state.env as MarkdownEnvironment;
  const rewritten: Token[] = [];

  for (let index = 0; index < state.tokens.length; index += 1) {
    const paragraphOpen = state.tokens[index];
    const inline = state.tokens[index + 1];
    const paragraphClose = state.tokens[index + 2];
    const only = inline?.children?.length === 1 ? inline.children[0] : undefined;
    if (
      paragraphOpen?.type === 'paragraph_open' &&
      paragraphOpen.level === 0 &&
      inline?.type === 'inline' &&
      paragraphClose?.type === 'paragraph_close' &&
      only?.type === 'image' &&
      isPersistableImageTarget(only.attrGet('src') ?? '')
    ) {
      const image = new state.Token('nix_image', 'img', 0);
      image.attrs = only.attrs;
      image.children = only.children;
      image.content = only.content;
      image.block = true;
      image.map = paragraphOpen.map;
      rewritten.push(image);
      index += 2;
      continue;
    }

    if (paragraphOpen?.type === 'inline' && paragraphOpen.children !== null) {
      paragraphOpen.children = rewriteInlineImages(paragraphOpen.children, environment);
    }
    if (paragraphOpen !== undefined) {
      rewritten.push(paragraphOpen);
    }
  }
  state.tokens = rewritten;
});

// markdown-it represents a table cell as inline tokens directly inside `th` or `td`. Nix's table
// schema correctly requires block content in every cell, so a direct MarkdownParser mapping drops
// those cells when `createAndFill` refuses the invalid shape. Injecting a paragraph pair around the
// inline stream expresses the structure Markdown already implied. Because this runs over tokens,
// not source text, pipe-like text inside a code fence is never mistaken for a table.
tokenizer.core.ruler.after('nix_import_images', 'nix_table_cell_blocks', (state) => {
  const wrapped: Token[] = [];
  for (const token of state.tokens) {
    if (token.type === 'th_close' || token.type === 'td_close') {
      wrapped.push(new state.Token('paragraph_close', 'p', -1));
    }
    wrapped.push(token);
    if (token.type === 'th_open' || token.type === 'td_open') {
      wrapped.push(new state.Token('paragraph_open', 'p', 1));
    }
  }
  state.tokens = wrapped;
});

function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function obsidianBoundaries(environment: MarkdownEnvironment, source: string): ObsidianBoundaries {
  const cached = environment.obsidianBoundaries.get(source);
  if (cached !== undefined) {
    return cached;
  }

  const closes: number[] = [];
  const newlines: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      newlines.push(index);
    }
    if (source[index] === ']' && source[index + 1] === ']') {
      closes.push(index);
      index += 1;
    }
  }
  const found = { closes, newlines };
  environment.obsidianBoundaries.set(source, found);
  return found;
}

function firstAtOrAfter(sorted: readonly number[], target: number): number | undefined {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const value = sorted[middle];
    if (value !== undefined && value < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return sorted[low];
}

function imageAlt(token: Token): string {
  return token.children?.map((child) => child.content).join('') ?? token.content;
}

function imageText(token: Token): string {
  const source = token.attrGet('src') ?? '';
  const alt = imageAlt(token);
  const title = token.attrGet('title');
  return `![${alt}](${source}${title === null ? '' : ` "${title}"`})`;
}

function replacementText(content: string): Token {
  const token = new Token('text', '', 0);
  token.content = content;
  return token;
}

function rewriteInlineImages(
  children: readonly Token[],
  environment: MarkdownEnvironment,
): Token[] {
  const rewritten: Token[] = [];
  let linkDepth = 0;

  for (const child of children) {
    if (child.type === 'link_open') {
      linkDepth += 1;
      rewritten.push(child);
      continue;
    }
    if (child.type === 'link_close') {
      linkDepth = Math.max(0, linkDepth - 1);
      rewritten.push(child);
      continue;
    }
    if (child.type !== 'image') {
      rewritten.push(child);
      continue;
    }

    const source = child.attrGet('src') ?? '';
    const alt = imageAlt(child);
    if (isLocalImageTarget(source)) {
      environment.importScan.unresolvedLocalImages += 1;
      environment.localImageTargets.push(source);
      if (linkDepth > 0 || !isAllowedLinkAddress(source)) {
        rewritten.push(replacementText(imageText(child)));
        continue;
      }
      const open = new Token('link_open', 'a', 1);
      open.attrs = [['href', source]];
      const title = child.attrGet('title');
      if (title !== null) {
        open.attrSet('title', title);
      }
      rewritten.push(open, replacementText(alt.length > 0 ? alt : source));
      rewritten.push(new Token('link_close', 'a', -1));
      continue;
    }

    if (!isPersistableImageTarget(source)) {
      environment.importScan.unsupportedImageAddresses += 1;
      rewritten.push(replacementText(imageText(child)));
      continue;
    }

    environment.importScan.inlineImagesFlattened += 1;
    if (linkDepth > 0 || !isAllowedLinkAddress(source)) {
      rewritten.push(replacementText(imageText(child)));
      continue;
    }

    const open = new Token('link_open', 'a', 1);
    open.attrs = [['href', source]];
    const title = child.attrGet('title');
    if (title !== null) {
      open.attrSet('title', title);
    }
    rewritten.push(open, replacementText(alt.length > 0 ? alt : source));
    rewritten.push(new Token('link_close', 'a', -1));
  }
  return rewritten;
}

/**
 * markdown-it token names mapped onto Nix's node and mark names.
 *
 * Nix's schema uses camelCase node names where prosemirror-markdown's default parser uses
 * snake_case, so this is a fresh map rather than a tweak of the default - a shared key would map to
 * a node the schema does not have.
 */
const tokens: Record<string, ParseSpec> = {
  blockquote: { block: 'blockquote' },
  paragraph: { block: 'paragraph' },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'tableRow' },
  th: { block: 'tableHeader', getAttrs: tableCellAttrs },
  td: { block: 'tableCell', getAttrs: tableCellAttrs },
  list_item: { block: 'listItem' },
  bullet_list: { block: 'bulletList' },
  task_list: { block: 'taskList' },
  task_item: {
    block: 'taskItem',
    getAttrs: (token) => ({ checked: token.attrGet('checked') === 'true' }),
  },
  ordered_list: {
    block: 'orderedList',
    getAttrs: (token) => ({ start: Number(token.attrGet('start') ?? 1) || 1 }),
  },
  heading: {
    block: 'heading',
    getAttrs: (token) => ({ level: Number(token.tag.slice(1)) || 1 }),
  },
  code_block: { block: 'codeBlock', noCloseToken: true },
  fence: {
    block: 'codeBlock',
    getAttrs: (token) => ({ language: token.info.trim() || null }),
    noCloseToken: true,
  },
  hr: { node: 'horizontalRule' },
  nix_image: {
    node: 'image',
    getAttrs: imageAttrs,
  },
  image: {
    node: 'image',
    getAttrs: imageAttrs,
  },
  hardbreak: { node: 'hardBreak' },
  em: { mark: 'italic' },
  strong: { mark: 'bold' },
  s: { mark: 'strike' },
  link: {
    mark: 'link',
    getAttrs: (token) => ({
      href: token.attrGet('href') ?? '',
      title: token.attrGet('title'),
    }),
  },
  code_inline: { mark: 'code', noCloseToken: true },
};

function imageAttrs(token: Token): Record<string, unknown> {
  const fromChildren = imageAlt(token);
  return {
    src: token.attrGet('src') ?? '',
    alt: fromChildren.length > 0 ? fromChildren : (token.attrGet('alt') ?? ''),
    title: token.attrGet('title'),
  };
}

/** The editor table attributes a Markdown cell can carry. */
function tableCellAttrs(token: Token): Record<string, unknown> {
  const alignment = /(?:^|;)\s*text-align:\s*(left|center|right)\s*(?:;|$)/i.exec(
    token.attrGet('style') ?? '',
  )?.[1];

  return {
    colspan: 1,
    rowspan: 1,
    colwidth: null,
    align: alignment?.toLowerCase() ?? null,
  };
}

const parser = new MarkdownParser(nixSchema, tokenizer, tokens);

/** `nix://<kind>/<targetId>` - the spelling `documentToMarkdown` gives a reference. */
const NIX_LINK = /^nix:\/\/([a-z]+)\/(.+)$/;

/** A blockquote's first line marker, `[!tone]` - the spelling it gives a callout. */
const CALLOUT_MARKER = /^\[!([a-z]+)]\s*/i;

function isKnownReferenceKind(kind: string): boolean {
  return (REFERENCE_KINDS as readonly string[]).includes(kind);
}

/**
 * Rewrite `documentToMarkdown`'s own details spelling into plain blocks before parsing.
 *
 * A `<details>` block has no node in a Markdown parser, and HTML is off. Rather than let the tags
 * survive as escaped text, the summary becomes a bold line and the wrapper is dropped, so the toggle
 * degrades to its readable content. The structure is not rebuilt - a details node does not round
 * trip - which is the one custom node this bridge cannot carry both ways.
 */
function stripDetails(markdown: string): string {
  return markdown
    .replace(/<details(?: data-toggle-level="\d+")?>\s*/g, '')
    .replace(
      /<summary>([\s\S]*?)<\/summary>/g,
      (_match, summary: string) => `**${summary.trim()}**\n`,
    )
    .replace(/\s*<\/details>/g, '');
}

/** Depth-first rewrite of the parsed JSON: link -> reference and `[!tone]` blockquote -> callout. */
function rebuildCustomNodes(node: JsonNode): JsonNode {
  const reference = asReference(node);
  if (reference !== null) {
    return reference;
  }

  const rewrittenChildren = node.content?.map((child) => rebuildCustomNodes(child));
  const withChildren: JsonNode =
    rewrittenChildren === undefined ? node : { ...node, content: rewrittenChildren };

  return asCallout(withChildren) ?? withChildren;
}

/** A text node carrying a single `nix://` link becomes a reference inline node. */
function asReference(node: JsonNode): JsonNode | null {
  if (node.type !== 'text' || node.marks === undefined) {
    return null;
  }

  const link = node.marks.find((mark) => mark.type === 'link');
  const href = typeof link?.attrs?.href === 'string' ? link.attrs.href : null;
  const match = href === null ? null : NIX_LINK.exec(href);
  const kindRaw = match?.[1];
  const targetId = match?.[2];
  if (kindRaw === undefined || targetId === undefined) {
    return null;
  }

  const kind = isKnownReferenceKind(kindRaw) ? kindRaw : 'item';
  return {
    type: 'reference',
    attrs: { kind, targetId, label: node.text ?? '' },
  };
}

/** A blockquote whose first paragraph is a `[!tone]` marker becomes a callout. */
function asCallout(node: JsonNode): JsonNode | null {
  if (node.type !== 'blockquote' || node.content === undefined || node.content.length === 0) {
    return null;
  }

  const first = node.content[0];
  const lead = first?.type === 'paragraph' ? first.content?.[0] : undefined;
  const match = lead?.type === 'text' ? CALLOUT_MARKER.exec(lead.text ?? '') : null;
  if (first === undefined || lead === undefined || match === null) {
    return null;
  }

  // The marker may stand alone or open the first paragraph (`> [!warning] Careful`).
  const remainder = (lead.text ?? '').slice(match[0].length);
  const leadRest = remainder.length > 0 ? [{ ...lead, text: remainder }] : [];
  const paragraphRest = [...leadRest, ...(first.content?.slice(1) ?? [])];
  const rest = [
    ...(paragraphRest.length > 0 ? [{ ...first, content: paragraphRest }] : []),
    ...node.content.slice(1),
  ];
  return {
    type: 'callout',
    attrs: { tone: (match[1] ?? 'note').toLowerCase() },
    content: rest.length > 0 ? rest : [{ type: 'paragraph' }],
  };
}

/**
 * Parse Markdown into a validated ProseMirror document body.
 *
 * @param markdown The Markdown source.
 * @returns The document JSON, or the reason it could not be produced.
 */
export function markdownToDocument(markdown: string): FromMarkdownResult {
  const importScan: MutableMarkdownImportScan = {
    unresolvedWikiLinks: 0,
    unresolvedObsidianEmbeds: 0,
    unresolvedLocalImages: 0,
    unsupportedImageAddresses: 0,
    inlineImagesFlattened: 0,
  };
  const environment: MarkdownEnvironment = {
    importScan,
    localImageTargets: [],
    obsidianBoundaries: new Map(),
  };

  let json: JsonNode;
  try {
    // MarkdownParser.parse returns a document node or throws; it never returns null.
    json = parser.parse(stripDetails(markdown), environment).toJSON() as JsonNode;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'The Markdown could not be parsed.',
    };
  }

  const rebuilt = rebuildCustomNodes(json);

  // The schema is the boundary, not the parser: a document that tokenised cleanly can still be a
  // shape the schema refuses (an empty doc, a mis-nested node), and that is a failure to report
  // rather than to hand on. parseDocument is the same gate the collaboration service applies.
  const parsed = parseDocument(rebuilt);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.error };
  }

  const rawSyntax = countRawSyntax(rebuilt);
  return {
    ok: true,
    doc: rebuilt,
    scan: Object.keys(rawSyntax).length > 0 ? { ...importScan, rawSyntax } : importScan,
    localImageTargets: environment.localImageTargets,
  };
}
