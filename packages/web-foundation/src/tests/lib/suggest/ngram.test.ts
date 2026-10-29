import { describe, expect, it } from 'vitest';

import { completePhrase, MAX_EXTRA_WORDS, NgramModel, sentences } from '../../../lib/suggest/ngram';

function trained(text: string, maxEntries?: number): NgramModel {
  const model = new NgramModel(maxEntries);
  model.train(text);
  return model;
}

describe('splitting text into sentences of words', () => {
  it('keeps inner apostrophes and the written case', () => {
    expect(sentences("Don't ship GitHub tokens")).toEqual([["Don't", 'ship', 'GitHub', 'tokens']]);
  });

  it('breaks at sentence punctuation and line breaks, so no phrase spans them', () => {
    expect(sentences('one two. three\nfour')).toEqual([['one', 'two'], ['three'], ['four']]);
  });
});

describe('completing the current word', () => {
  it('finishes a word started in a context it has been seen in twice', () => {
    const model = trained('the quarterly review. the quarterly review.');

    expect(completePhrase('the quar', [model])?.text).toBe('terly review');
  });

  it('offers nothing for a phrase written only once', () => {
    // Two is the evidence floor: a single occurrence is not a habit.
    const model = trained('the quarterly review');

    expect(completePhrase('the quar', [model])).toBeNull();
  });

  it('offers nothing for a single typed letter', () => {
    const model = trained('quarterly quarterly quarterly');

    expect(completePhrase('q', [model])).toBeNull();
  });

  it('puts the word back the way it is written', () => {
    const model = trained('push to GitHub. push to GitHub.');

    expect(completePhrase('push to Gi', [model])?.text).toBe('tHub');
  });

  it('declines when the context is evidenced but ambiguous, rather than guessing from frequency', () => {
    // "the" is followed by three different "pla" words once each; the bigram has evidence and no
    // winner, and the far more frequent "plans" on its own must not overrule it.
    const model = trained('the plans. the planet. the plaza. plans plans plans plans.');

    expect(completePhrase('the pla', [model])).toBeNull();
  });

  it('backs off to a shorter context when the longer one has no evidence', () => {
    const model = trained('weekly review notes. weekly review notes.');

    expect(completePhrase('my weekly rev', [model])?.text).toMatch(/^iew/);
  });

  it('is deterministic when counts tie, preferring the shorter word', () => {
    const model = trained('go homestead. go homesteader. go homestead. go homesteader.');

    // Equal counts hold exactly half the evidence each, which clears the 0.5 floor.
    expect(completePhrase('go hom', [model])?.text).toBe('estead');
  });
});

describe('suggesting the next words', () => {
  it('suggests the next word after a single space from context, never from bare frequency', () => {
    const model = trained('see you tomorrow. see you tomorrow.');

    expect(completePhrase('see you ', [model])?.text).toBe('tomorrow');
    // No context word at all: nothing to go on but frequency, so nothing is offered.
    expect(completePhrase('', [model])).toBeNull();
  });

  it('stops at the extra-word ceiling', () => {
    const phrase = 'alpha beta gamma delta epsilon zeta eta';
    const model = trained(`${phrase}. ${phrase}. ${phrase}.`);

    const completion = completePhrase('alpha be', [model]);
    expect(completion?.extraWords).toBe(MAX_EXTRA_WORDS);
    expect(completion?.text).toBe('ta gamma delta epsilon');
  });

  it('offers nothing after punctuation or two spaces, where somebody paused on purpose', () => {
    const model = trained('see you tomorrow. see you tomorrow.');

    expect(completePhrase('see you,', [model])).toBeNull();
    expect(completePhrase('see you  ', [model])).toBeNull();
  });

  it('starts fresh after a full stop, so the words before it are not context', () => {
    const model = trained('big red car. big red car. small red hat. small red hat. small red hat.');

    expect(completePhrase('big red ', [model])?.text).toBe('car');
    // Across the full stop "big" is no longer context; "red" alone says "hat".
    expect(completePhrase('big. red ', [model])?.text).toBe('hat');
  });

  it('sums evidence across models, so a phrase in two notes counts twice', () => {
    const first = trained('the launch checklist');
    const second = trained('the launch checklist');

    expect(completePhrase('the launch ch', [first])).toBeNull();
    expect(completePhrase('the launch ch', [first, second])?.text).toBe('ecklist');
  });

  it('drops a ghost too short to be worth drawing', () => {
    const model = trained('the cat. the cat. the cat.');

    expect(completePhrase('the ca', [model])).toBeNull();
  });
});

describe('the memory bound', () => {
  it('never holds more counts than its bound, and keeps what recurs', () => {
    const model = new NgramModel(200);
    const noise = Array.from({ length: 400 }, (_, index) => `word${String(index)}`).join(' ');
    model.train(
      `${noise}. standing meeting agenda. standing meeting agenda. standing meeting agenda.`,
    );
    model.train('standing meeting agenda. standing meeting agenda.');

    expect(model.size).toBeLessThanOrEqual(200);
    expect(completePhrase('standing meeting ag', [model])?.text).toBe('enda');
  });

  it('prunes while it trains, so even one long sentence never holds far more than its bound', () => {
    const model = new NgramModel(200);
    const noise = Array.from({ length: 2_000 }, (_, index) => `word${String(index)}`).join(' ');

    model.train(noise);

    // One word adds at most a unigram, a bigram and a trigram before the next check.
    expect(model.peak).toBeLessThanOrEqual(203);
  });

  it('does not learn very long tokens, which are addresses and identifiers', () => {
    const long = 'x'.repeat(41);
    const model = trained(`${long} ${long} ${long}`);

    expect(model.size).toBe(0);
  });
});
