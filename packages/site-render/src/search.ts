/**
 * The client-side search index: each published page's title and words, as token postings.
 *
 * Built only from pages the site actually rendered, so the public index can never name a page
 * that is not published. Tokens are NFKD-folded, lowercased runs of letters and digits, two
 * characters or longer. The index is capped at {@link SEARCH_INDEX_LIMIT}: past it, page bodies are
 * dropped (titles stay) and the caller reports a partial index.
 */

export const SEARCH_INDEX_LIMIT = 2 * 1024 * 1024;

export interface SearchDocument {
  readonly path: string;
  readonly title: string;
  readonly text: string;
}

export interface SearchIndex {
  readonly docs: readonly { readonly p: string; readonly t: string }[];
  readonly terms: Readonly<Record<string, readonly number[]>>;
}

export function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token.length <= 40);
}

/**
 * The index, or null as soon as its JSON could no longer fit in `limit` bytes. The size is kept as
 * postings are added (tokens are ASCII, so characters are bytes; the titles and paths are measured
 * once), so an oversized site stops here instead of building and serializing an index to discard.
 */
function build(
  documents: readonly SearchDocument[],
  withBodies: boolean,
  limit: number,
): SearchIndex | null {
  const sorted = [...documents].sort((a, b) => a.path.localeCompare(b.path));
  const docs = sorted.map((doc) => ({ p: doc.path, t: doc.title }));
  // `{"docs":` + docs + `,"terms":{` + terms + `}}`
  let bytes = 8 + Buffer.byteLength(JSON.stringify(docs)) + 10 + 2;
  if (bytes > limit) return null;
  const postings = new Map<string, Set<number>>();
  for (const [index, doc] of sorted.entries()) {
    const digits = String(index).length;
    for (const token of tokenize(withBodies ? `${doc.title} ${doc.text}` : doc.title)) {
      let set = postings.get(token);
      if (set === undefined) {
        set = new Set();
        // `"token":[]`, and a comma before every term but the first.
        bytes += token.length + 5 + (postings.size > 0 ? 1 : 0);
        postings.set(token, set);
      }
      if (!set.has(index)) {
        bytes += digits + (set.size > 0 ? 1 : 0);
        set.add(index);
      }
    }
    if (bytes > limit) return null;
  }
  const terms: Record<string, number[]> = {};
  for (const token of [...postings.keys()].sort()) {
    terms[token] = [...(postings.get(token) ?? [])].sort((a, b) => a - b);
  }
  return { docs, terms };
}

export function buildSearchIndex(
  documents: readonly SearchDocument[],
  limit = SEARCH_INDEX_LIMIT,
): {
  json: string;
  partial: boolean;
} {
  const full = build(documents, true, limit);
  if (full !== null) {
    return { json: JSON.stringify(full), partial: false };
  }
  // The fallback is never refused for size: titles alone are what a partial index means.
  return { json: JSON.stringify(build(documents, false, Infinity)), partial: true };
}
