import { trigrams } from './tokenize';

/**
 * Whether a title being typed already names something that exists.
 *
 * **Character trigrams, compared by Jaccard similarity** - the same measure `titleSimilarity` uses,
 * computed here against many candidates with the typed title's trigrams built once rather than once
 * per candidate. Trigrams forgive what people actually do to a title they retype - a plural, a
 * dropped word, a typo - while two titles that merely share a theme stay apart: "Invoice March"
 * and "Invoice April" share a word and score about 0.4, under the bar.
 *
 * **The bar is {@link DUPLICATE_THRESHOLD}, and it is a bar for saying something, not for doing
 * anything.** A match produces a sentence and a way to open the other item; it never blocks a
 * create, merges anything or changes a title. Somebody making a second "Weekly review" on purpose
 * reads one line and carries on.
 *
 * Pure: candidates come from wherever the caller has them - a container's loaded children, a search
 * response - and this never fetches.
 */

/** The similarity at or above which a title is worth calling out as possibly the same thing. */
export const DUPLICATE_THRESHOLD = 0.6;

/** The shortest title worth checking. Two characters match half of everything. */
export const MINIMUM_DUPLICATE_QUERY = 3;

export interface TitledCandidate {
  readonly id: string;
  readonly title: string;
}

export interface SimilarTitle {
  readonly id: string;
  readonly title: string;

  /** Jaccard similarity of the two titles' trigram sets, from 0 to 1. */
  readonly similarity: number;
}

/**
 * The candidates whose titles are at least `threshold` similar to `title`, most similar first.
 *
 * Returns nothing for a title shorter than {@link MINIMUM_DUPLICATE_QUERY} once trimmed. `limit`
 * bounds the answer, not the work: every candidate is scored, because the most similar one may be
 * the last.
 */
export function similarTitles(
  title: string,
  candidates: readonly TitledCandidate[],
  threshold: number = DUPLICATE_THRESHOLD,
  limit = 3,
): readonly SimilarTitle[] {
  const typed = title.trim();
  if (typed.length < MINIMUM_DUPLICATE_QUERY) {
    return [];
  }

  const left = trigrams(typed);
  if (left.size === 0) {
    return [];
  }

  const matches: SimilarTitle[] = [];
  for (const candidate of candidates) {
    const right = trigrams(candidate.title);
    if (right.size === 0) {
      continue;
    }
    let shared = 0;
    for (const gram of left) {
      if (right.has(gram)) {
        shared += 1;
      }
    }
    const similarity = shared / (left.size + right.size - shared);
    if (similarity >= threshold) {
      matches.push({ id: candidate.id, title: candidate.title, similarity });
    }
  }

  return matches.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}
