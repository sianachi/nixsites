/**
 * A word-level phrase model: given the text before the caret, what the person is most likely
 * typing next - the rest of the current word, and perhaps the next few words after it.
 *
 * **Counts, not a network.** Every prediction here is a ratio of two counts somebody could check
 * by hand: of the times these two words were followed by something starting with "ar", how many
 * were "architecture". That is what makes a ghost suggestion explainable and its thresholds
 * tunable, and it is all a personal notes corpus can support - there is not enough text in one
 * person's notes to train anything that generalises further than "you have written this before".
 *
 * **Trigram context with backoff.** A prediction is decided at the most specific level that has
 * evidence: the last two words (trigram), else the last word (bigram), else the word on its own
 * (unigram, and only to finish a word already started). The level that has enough evidence makes
 * the decision outright - an ambiguous trigram does not fall through to a confident unigram,
 * because the trigram knows more about this sentence and has said "it could be several things".
 *
 * **Memory is bounded by construction.** A model holds at most `maxEntries` distinct counts. Past
 * that it halves every count and drops what reaches zero, which removes the long tail of words
 * seen once and ages everything else - so a model trained on more text than its bound keeps the
 * phrases that recur, which are the only ones worth suggesting anyway.
 *
 * **Never persisted.** This module holds counts in memory and has no storage of its own on
 * purpose. The text it learns from is document content, governed where it lives (locks, sign-out,
 * the body cache's age and record limits); a serialised model would be a copy of that content
 * outside every one of those rules. Callers keep models in memory and drop them when the
 * documents they came from must be forgotten.
 *
 * **Why its own word pattern, not `tokenize.ts`'s.** That tokenizer lower-cases and splits on
 * apostrophes, which is right for classifying titles and wrong for writing them: a completion has
 * to put back "don't" and "GitHub" the way the person spells them. Words here keep inner
 * apostrophes, and each word remembers the surface form it was last written in.
 */

/** A model's bound on distinct counts (words, word pairs and word triples together). */
export const DEFAULT_MAX_ENTRIES = 20_000;

/** The shortest word start a completion is offered for. One letter predicts nothing useful. */
export const MIN_PREFIX = 2;

/**
 * How much evidence a level needs before it decides: the matching continuations' counts summed.
 * Two means "seen at least twice in this context", so a phrase written once is never offered.
 */
export const MIN_EVIDENCE = 2;

/** The share of a level's evidence the winning word must hold to be offered for the current word. */
export const MIN_SHARE = 0.5;

/**
 * The stricter share each extra word after the current one must hold. Every extra word is a
 * further guess stacked on the last, and a long wrong ghost is worse than a short right one.
 */
export const EXTRA_WORD_SHARE = 0.6;

/** The most whole words offered after the current one. */
export const MAX_EXTRA_WORDS = 3;

/**
 * The shortest ghost worth drawing, in characters. Finishing "th" as "the" saves one keystroke and
 * costs a flicker on every pause; below this the suggestion is noise.
 */
export const MIN_GHOST_LENGTH = 3;

/** Words longer than this are not learned: they are addresses, hashes and pasted identifiers. */
const MAX_WORD_LENGTH = 40;

/** A word: letters and digits in any script, with apostrophes allowed inside ("don't", "o’clock"). */
const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/** Where a phrase cannot continue across: sentence punctuation and line breaks. */
const SENTENCE_BREAK = /[.!?;:\n…￼]+/u;

/** The words of each sentence in `text`, in their written form. */
export function sentences(text: string): string[][] {
  return text
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.match(WORD) ?? [])
    .filter((words) => words.length > 0);
}

/** One continuation chosen at one level, with the counts that chose it. */
interface Choice {
  readonly word: string;
  readonly count: number;
  readonly evidence: number;
  readonly level: 1 | 2 | 3;
}

/** A completion offered for the text before the caret. */
export interface PhraseCompletion {
  /** What would be inserted at the caret, exactly: the rest of the word and any words after it. */
  readonly text: string;
  /** How many whole words follow the current one. */
  readonly extraWords: number;
  /** The weakest share that any part of the completion was chosen with, from 0.5 to 1. */
  readonly confidence: number;
}

export class NgramModel {
  private readonly unigrams = new Map<string, number>();
  /** The last written form of each word, by its lower-cased key. */
  private readonly surfaces = new Map<string, string>();
  private readonly bigrams = new Map<string, Map<string, number>>();
  private readonly trigrams = new Map<string, Map<string, number>>();
  private entries = 0;
  private peakEntries = 0;

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  /** How many distinct counts the model holds; never more than its bound after a `train`. */
  get size(): number {
    return this.entries;
  }

  /**
   * The most distinct counts the model has held at any moment, during training included. Pruning
   * runs after every word, so this stays within one word's three counts of the bound however much
   * text one `train` call is given.
   */
  get peak(): number {
    return this.peakEntries;
  }

  /** Learns every phrase in `text`. Sentences are learned separately; nothing spans a full stop. */
  train(text: string): void {
    for (const sentence of sentences(text)) {
      let previous: string | null = null;
      let beforePrevious: string | null = null;
      for (const written of sentence) {
        if (written.length > MAX_WORD_LENGTH) {
          // Not learned, and it breaks the context: the words either side were never adjacent.
          previous = null;
          beforePrevious = null;
          continue;
        }
        const word = written.toLowerCase();
        this.bump(this.unigrams, word);
        this.surfaces.set(word, written);
        if (previous !== null) {
          this.bumpNested(this.bigrams, previous, word);
          if (beforePrevious !== null) {
            this.bumpNested(this.trigrams, `${beforePrevious} ${previous}`, word);
          }
        }
        beforePrevious = previous;
        previous = word;
        this.peakEntries = Math.max(this.peakEntries, this.entries);
        // Pruned as it goes rather than once at the end, so a long document never builds a table
        // many times the bound before cutting it down.
        while (this.entries > this.maxEntries) {
          this.prune();
        }
      }
    }
  }

  /**
   * Every continuation of `context` starting with `prefix`, with its count, at one level.
   *
   * `context` is lower-cased words, most recent last; level 3 reads the last two, level 2 the last
   * one, level 1 none.
   */
  continuations(
    context: readonly string[],
    prefix: string,
    level: 1 | 2 | 3,
  ): ReadonlyMap<string, number> {
    const table =
      level === 3
        ? context.length >= 2
          ? this.trigrams.get(`${context.at(-2) ?? ''} ${context.at(-1) ?? ''}`)
          : undefined
        : level === 2
          ? context.length >= 1
            ? this.bigrams.get(context.at(-1) ?? '')
            : undefined
          : this.unigrams;
    if (table === undefined) {
      return EMPTY;
    }
    if (prefix.length === 0) {
      return table;
    }
    const matching = new Map<string, number>();
    for (const [word, count] of table) {
      if (word.length > prefix.length && word.startsWith(prefix)) {
        matching.set(word, count);
      }
    }
    return matching;
  }

  /** How `word` (lower-cased) was last written. */
  surface(word: string): string {
    return this.surfaces.get(word) ?? word;
  }

  private bump(table: Map<string, number>, key: string): void {
    const count = table.get(key);
    if (count === undefined) {
      this.entries += 1;
    }
    table.set(key, (count ?? 0) + 1);
  }

  private bumpNested(table: Map<string, Map<string, number>>, context: string, word: string): void {
    let inner = table.get(context);
    if (inner === undefined) {
      inner = new Map();
      table.set(context, inner);
    }
    this.bump(inner, word);
  }

  /** Halves every count and drops the ones that reach zero: the long tail goes, the rest ages. */
  private prune(): void {
    let entries = 0;
    for (const [word, count] of this.unigrams) {
      const halved = Math.floor(count / 2);
      if (halved === 0) {
        this.unigrams.delete(word);
        this.surfaces.delete(word);
      } else {
        this.unigrams.set(word, halved);
        entries += 1;
      }
    }
    for (const table of [this.bigrams, this.trigrams]) {
      for (const [context, inner] of table) {
        for (const [word, count] of inner) {
          const halved = Math.floor(count / 2);
          if (halved === 0) {
            inner.delete(word);
          } else {
            inner.set(word, halved);
            entries += 1;
          }
        }
        if (inner.size === 0) {
          table.delete(context);
        }
      }
    }
    this.entries = entries;
  }
}

const EMPTY: ReadonlyMap<string, number> = new Map();

/**
 * The best continuation across `models`, decided at the most specific level with evidence.
 *
 * Counts from every model are summed: each model is one source of text (this document, another
 * note), and a phrase written in two notes is twice the evidence of a phrase written in one.
 * Ties go to the shorter word, then alphabetical order, so the same counts always produce the
 * same suggestion.
 */
function choose(
  models: readonly NgramModel[],
  context: readonly string[],
  prefix: string,
  lowestLevel: 1 | 2,
): Choice | null {
  const levels: readonly (1 | 2 | 3)[] = lowestLevel === 1 ? [3, 2, 1] : [3, 2];
  for (const level of levels) {
    if (level === 3 && context.length < 2) continue;
    if (level === 2 && context.length < 1) continue;
    const totals = new Map<string, number>();
    for (const model of models) {
      for (const [word, count] of model.continuations(context, prefix, level)) {
        totals.set(word, (totals.get(word) ?? 0) + count);
      }
    }
    let evidence = 0;
    let best: string | null = null;
    let bestCount = 0;
    for (const [word, count] of totals) {
      evidence += count;
      if (
        best === null ||
        count > bestCount ||
        (count === bestCount &&
          (word.length < best.length || (word.length === best.length && word < best)))
      ) {
        best = word;
        bestCount = count;
      }
    }
    if (best !== null && evidence >= MIN_EVIDENCE) {
      return { word: best, count: bestCount, evidence, level };
    }
  }
  return null;
}

/** How `models` collectively write `word`: the first model that has seen it decides. */
function surfaceOf(models: readonly NgramModel[], word: string): string {
  for (const model of models) {
    const written = model.surface(word);
    if (written !== word) return written;
  }
  return word;
}

/**
 * What to suggest after `before` - the text of the current block up to the caret - or `null`.
 *
 * Offered in two situations only. Mid-word (the text ends in a letter or digit, at least
 * `MIN_PREFIX` of them): the rest of that word, decided at any level. Right after a single space:
 * the next word, decided by context alone, never by bare word frequency - "the most common word
 * you write" is not a prediction. Anything else (punctuation, two spaces, an empty block) is a
 * place somebody has paused deliberately, and nothing is offered.
 *
 * Whole words after the first are added while each clears `EXTRA_WORD_SHARE`, up to
 * `MAX_EXTRA_WORDS`. The whole is dropped if it is shorter than `MIN_GHOST_LENGTH`.
 */
export function completePhrase(
  before: string,
  models: readonly NgramModel[],
): PhraseCompletion | null {
  if (models.length === 0 || before.length === 0) {
    return null;
  }
  const midWord = /[\p{L}\p{N}]$/u.test(before);
  if (!midWord && !/[^\s] $/u.test(before)) {
    return null;
  }

  // Only the current sentence is context: a full stop is a fresh start.
  const parts = before.split(SENTENCE_BREAK);
  const sentence = parts.at(-1) ?? '';
  const written = sentence.match(WORD) ?? [];
  const lower = written.map((word) => word.toLowerCase());

  let prefix = '';
  let context = lower;
  if (midWord) {
    const last = written.at(-1);
    // The text ends in a word character that is not the end of a matched word - an apostrophe
    // the pattern could not close, say. Nothing sensible to finish.
    if (last === undefined || !sentence.endsWith(last)) return null;
    prefix = last.toLowerCase();
    if (prefix.length < MIN_PREFIX) return null;
    context = lower.slice(0, -1);
  }

  const first = choose(models, context, prefix, midWord ? 1 : 2);
  if (first === null || first.count / first.evidence < MIN_SHARE) {
    return null;
  }

  // The rest of the word as it is usually written, but only when that spelling still extends what
  // was typed - "Gi" finishing as "tHub" from "GitHub" is fine, "gi" against "GitHub" is not.
  const typed = midWord ? (written.at(-1) ?? '') : '';
  const firstSurface = surfaceOf(models, first.word);
  const firstTail = firstSurface.startsWith(typed)
    ? firstSurface.slice(typed.length)
    : first.word.slice(typed.length);
  let text = firstTail;
  let confidence = first.count / first.evidence;
  let extraWords = 0;

  const running = [...context, first.word];
  while (extraWords < MAX_EXTRA_WORDS) {
    const next = choose(models, running, '', 2);
    if (next === null) break;
    const share = next.count / next.evidence;
    if (share < EXTRA_WORD_SHARE) break;
    text += ` ${surfaceOf(models, next.word)}`;
    confidence = Math.min(confidence, share);
    running.push(next.word);
    extraWords += 1;
  }

  if (text.length < MIN_GHOST_LENGTH) {
    return null;
  }
  return { text, extraWords, confidence };
}
