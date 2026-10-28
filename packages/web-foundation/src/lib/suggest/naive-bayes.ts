/**
 * Which value a short piece of text usually goes with, learned from examples already labelled.
 *
 * **A multinomial naive Bayes classifier, and nothing cleverer.** A container's children are a
 * small labelled corpus - each child's title, and the value its select (or multi-select, or
 * assignee) property holds - and "titles mentioning 'invoice' are usually filed under Bills" is
 * exactly the regularity this model captures. It trains in one pass, predicts in one pass over the
 * new title's words, needs no server and no model file, and its reasoning can be stated in a
 * sentence a person can check against their own data, which is the property that matters most for
 * a suggestion: somebody who can see why it was offered can tell when it is wrong.
 *
 * **Laplace smoothing**, so a word seen with one value and never with another does not drive the
 * other value's probability to zero. **Words never seen in training are ignored** rather than
 * smoothed: smoothing an unseen word adds a per-value penalty that depends only on how many words
 * that value has, which biases every prediction towards the smallest category for a reason that has
 * nothing to do with the title.
 *
 * **Deliberately quiet.** `suggestValue` answers null unless every one of these holds:
 *
 * - at least {@link SUGGESTION_THRESHOLDS.minimumLabelled} examples carry a value, and at least two
 *   different values occur - one value everywhere is a default, not a prediction;
 * - the title shares at least one word with the training titles - otherwise the posterior is just
 *   the prior, and "most items are Todo" is not something learned from this title;
 * - the winning value's posterior is at least {@link SUGGESTION_THRESHOLDS.minimumPosterior};
 * - some word in the title has been seen with the winning value in at least
 *   {@link SUGGESTION_THRESHOLDS.minimumEvidence} examples, and at least
 *   {@link SUGGESTION_THRESHOLDS.minimumShare} of the labelled examples containing that word carry
 *   it - the word the explanation names. A suggestion is only offered with a reason a person can
 *   check against their own list and find supportive; "2 of the 9 items with 'invoice' use Bills"
 *   would be a reason against, so no word qualifying means no suggestion.
 *
 * The defaults were tuned against small hand-built corpora in the tests (a dozen titled bills and
 * errands): at 0.6 a single shared word with three supporting examples clears the bar while a
 * title split evenly between two categories does not, and five labelled examples is the smallest
 * corpus where one coincidence cannot by itself produce a confident suggestion.
 *
 * Pure: no storage, no clock, no React. Callers tokenize (see `tokenize.ts`) so every suggester
 * agrees on what a word is.
 */

/** One labelled example: the words of its text, and every value it carries (several for a multi-select). */
export interface LabelledExample {
  readonly tokens: readonly string[];
  readonly values: readonly string[];
}

/** The bars a prediction must clear before it is offered. */
export interface SuggestionThresholds {
  /** Examples carrying a value before anything is suggested at all. */
  readonly minimumLabelled: number;

  /** The winning value's posterior probability, from 0 to 1. */
  readonly minimumPosterior: number;

  /** Examples that pair the explaining word with the winning value. */
  readonly minimumEvidence: number;

  /** The least share of labelled examples containing the explaining word that carry the value. */
  readonly minimumShare: number;
}

export const SUGGESTION_THRESHOLDS: SuggestionThresholds = {
  minimumLabelled: 5,
  minimumPosterior: 0.6,
  minimumEvidence: 2,
  minimumShare: 0.5,
};

/** A trained model. Opaque in spirit; exported so a caller can hold one between predictions. */
export interface ValueModel {
  /** Examples that carried at least one value. */
  readonly labelled: number;

  /** Per value: how many examples carry it (the prior's numerator). */
  readonly documents: ReadonlyMap<string, number>;

  /** Per value: how many times each word occurs across its examples (the multinomial counts). */
  readonly wordCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;

  /** Per value: the total of its word counts (the likelihood's denominator, before smoothing). */
  readonly wordTotals: ReadonlyMap<string, number>;

  /** Every word seen in a labelled example. */
  readonly vocabulary: ReadonlySet<string>;

  /** Per word: how many labelled examples contain it at least once (for the explanation). */
  readonly examplesWithWord: ReadonlyMap<string, number>;

  /** Per word, per value: how many labelled examples contain the word and carry the value. */
  readonly examplesWithWordAndValue: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** Why a suggestion was made, in numbers a sentence can quote. */
export interface SuggestionEvidence {
  /** The title word that most strongly points at the value. */
  readonly word: string;

  /** Labelled examples containing the word that carry the value. */
  readonly withValue: number;

  /** Labelled examples - ones with this property set - containing the word at all. */
  readonly withWord: number;
}

export interface ValueSuggestion {
  readonly value: string;

  /** The posterior probability of `value`, from 0 to 1. */
  readonly posterior: number;

  readonly evidence: SuggestionEvidence;
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function nested(map: Map<string, Map<string, number>>, key: string): Map<string, number> {
  let inner = map.get(key);
  if (inner === undefined) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

/**
 * Trains a model from labelled examples. Examples carrying no value are skipped - an unlabelled
 * item says nothing about which label goes with which word.
 *
 * A multi-valued example counts once towards each of its values, which is the usual way to fit a
 * single-label classifier to multi-label data: it answers "which one value is most likely", which
 * is all a suggestion offers.
 */
export function trainValueModel(examples: readonly LabelledExample[]): ValueModel {
  let labelled = 0;
  const documents = new Map<string, number>();
  const wordCounts = new Map<string, Map<string, number>>();
  const wordTotals = new Map<string, number>();
  const vocabulary = new Set<string>();
  const examplesWithWord = new Map<string, number>();
  const examplesWithWordAndValue = new Map<string, Map<string, number>>();

  for (const example of examples) {
    const values = [...new Set(example.values.filter((value) => value.length > 0))];
    if (values.length === 0) {
      continue;
    }
    labelled += 1;

    for (const value of values) {
      bump(documents, value);
      const counts = nested(wordCounts, value);
      for (const word of example.tokens) {
        bump(counts, word);
      }
      bump(wordTotals, value, example.tokens.length);
    }

    for (const word of new Set(example.tokens)) {
      vocabulary.add(word);
      bump(examplesWithWord, word);
      const byValue = nested(examplesWithWordAndValue, word);
      for (const value of values) {
        bump(byValue, value);
      }
    }
  }

  return {
    labelled,
    documents,
    wordCounts,
    wordTotals,
    vocabulary,
    examplesWithWord,
    examplesWithWordAndValue,
  };
}

/**
 * Every value's posterior probability for `tokens`, highest first.
 *
 * Exported for tests and for a caller that wants to show alternatives; `suggestValue` is the one
 * that decides whether anything is worth offering. Empty when the model has no values.
 */
export function posteriors(
  model: ValueModel,
  tokens: readonly string[],
): readonly { readonly value: string; readonly posterior: number }[] {
  const known = tokens.filter((word) => model.vocabulary.has(word));
  const vocabularySize = model.vocabulary.size;
  const totalDocuments = [...model.documents.values()].reduce((sum, count) => sum + count, 0);

  const logs: { value: string; log: number }[] = [];
  for (const [value, count] of model.documents) {
    let log = Math.log(count / totalDocuments);
    const counts = model.wordCounts.get(value);
    const denominator = (model.wordTotals.get(value) ?? 0) + vocabularySize;
    for (const word of known) {
      log += Math.log(((counts?.get(word) ?? 0) + 1) / denominator);
    }
    logs.push({ value, log });
  }

  if (logs.length === 0) {
    return [];
  }

  // Log-sum-exp, so a long title's tiny products do not underflow to zero before normalising.
  const peak = Math.max(...logs.map((entry) => entry.log));
  const total = logs.reduce((sum, entry) => sum + Math.exp(entry.log - peak), 0);

  return logs
    .map((entry) => ({ value: entry.value, posterior: Math.exp(entry.log - peak) / total }))
    .sort(
      (left, right) => right.posterior - left.posterior || left.value.localeCompare(right.value),
    );
}

/**
 * The value worth suggesting for `tokens`, with the word that explains it, or null.
 *
 * See the module comment for every condition a suggestion must meet. `exclude` lists values the
 * caller already knows (the item already holds them), so a multi-select is never offered a value
 * it has.
 */
export function suggestValue(
  model: ValueModel,
  tokens: readonly string[],
  thresholds: SuggestionThresholds = SUGGESTION_THRESHOLDS,
  exclude: ReadonlySet<string> = new Set(),
): ValueSuggestion | null {
  if (model.labelled < thresholds.minimumLabelled || model.documents.size < 2) {
    return null;
  }

  const known = [...new Set(tokens.filter((word) => model.vocabulary.has(word)))];
  if (known.length === 0) {
    return null;
  }

  const best = posteriors(model, known).find((entry) => !exclude.has(entry.value));
  if (best === undefined || best.posterior < thresholds.minimumPosterior) {
    return null;
  }

  // The explaining word: the one whose examples most often carry the winning value, among words
  // with enough of them to be worth quoting. Ties go to the better-supported word, then to the
  // word's own order so the sentence is stable from one keystroke to the next.
  let evidence: SuggestionEvidence | null = null;
  for (const word of known) {
    const withWord = model.examplesWithWord.get(word) ?? 0;
    const withValue = model.examplesWithWordAndValue.get(word)?.get(best.value) ?? 0;
    if (withValue < thresholds.minimumEvidence || withWord === 0) {
      continue;
    }
    const share = withValue / withWord;
    if (share < thresholds.minimumShare) {
      continue;
    }
    const incumbent = evidence === null ? -1 : evidence.withValue / evidence.withWord;
    if (
      evidence === null ||
      share > incumbent ||
      (share === incumbent && withValue > evidence.withValue)
    ) {
      evidence = { word, withValue, withWord };
    }
  }

  return evidence === null ? null : { value: best.value, posterior: best.posterior, evidence };
}
