/**
 * Words out of short text, the same way for every suggester that learns from it.
 *
 * One tokenizer so a property-value model trained on titles, a duplicate check and a phrase model
 * all agree on what a word is. Lower-cased, split on anything that is not a letter or a digit in
 * any script, and stripped of a small set of English function words that carry no signal for
 * "which category is this" - the list is deliberately short, because a word dropped here can never
 * be learned from.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/** Every word in `text`, lower-cased and in order, including function words. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The words of `text` worth learning from: no function words, nothing shorter than two characters. */
export function tokens(text: string): string[] {
  return words(text).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

/** The distinct character trigrams of `text`, padded so short words still produce some. */
export function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (const word of words(text)) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      grams.add(padded.slice(index, index + 3));
    }
  }
  return grams;
}

/** Jaccard similarity of two titles' trigram sets, from 0 (nothing shared) to 1 (identical). */
export function titleSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}
