import { describe, expect, it } from 'vitest';

import {
  rankReferences,
  RECENCY_HALF_LIFE_MS,
  REFERENCE_WEIGHTS,
  type ReferenceCandidate,
} from '../../../lib/suggest/rank-references';

const NOW = Date.parse('2026-10-01T12:00:00Z');

function candidate(id: string, title: string | null, extra: Partial<ReferenceCandidate> = {}) {
  return { id, title, ...extra };
}

/**
 * `pool` followed by unrelated results, so neighbouring priors sit as close as they do in the real
 * pool of 25 rather than half the scale apart.
 */
function padded(pool: readonly ReferenceCandidate[]): ReferenceCandidate[] {
  const filler = Array.from({ length: 20 }, (_, index) =>
    candidate(`filler-${String(index)}`, 'Unrelated'),
  );
  return [...pool, ...filler];
}

function ids(ranked: readonly { candidate: ReferenceCandidate }[]): string[] {
  return ranked.map((entry) => entry.candidate.id);
}

describe('ranking reference candidates', () => {
  it('keeps the server order exactly when there is no history and no other signal', () => {
    const pool = [candidate('a', 'Alpha'), candidate('b', 'Beta'), candidate('c', 'Gamma')];

    expect(ids(rankReferences(pool, { query: 'zzz', now: NOW }))).toEqual(['a', 'b', 'c']);
  });

  it('shows at most the limit, cut after ranking rather than before', () => {
    const pool = Array.from({ length: 25 }, (_, index) =>
      candidate(`item-${String(index)}`, `Plan ${String(index)}`),
    );
    const frecency = new Map([['item-24', 10]]);

    const ranked = rankReferences(pool, { query: 'plan', frecency, now: NOW }, 8);

    expect(ranked).toHaveLength(8);
    // The last result the server returned is the one this person picks, so it is shown first.
    expect(ranked[0]?.candidate.id).toBe('item-24');
  });

  it('promotes what this person picks often, within the same match quality', () => {
    const pool = [
      candidate('first', 'Roadmap draft'),
      candidate('second', 'Roadmap'),
      candidate('third', 'Roadmap archive'),
    ];
    const frecency = new Map([['third', 3]]);

    expect(ids(rankReferences(pool, { query: 'road', frecency, now: NOW }))).toEqual([
      'third',
      'first',
      'second',
    ]);
  });

  it('does not let a single pick lift a body-only match over a title named what was typed', () => {
    // The server put the body match second. One pick is worth half the frecency weight, which is
    // less than a title match is worth.
    const pool = [candidate('titled', 'Budget 2026'), candidate('body', 'Misc notes')];
    const frecency = new Map([['body', 1]]);

    expect(ids(rankReferences(pool, { query: 'budget', frecency, now: NOW }))).toEqual([
      'titled',
      'body',
    ]);
  });

  it('gives a word-start title match more than a match inside a word', () => {
    const pool = padded([candidate('inside', 'Subplan'), candidate('start', 'Plan review')]);

    const ranked = rankReferences(pool, { query: 'plan', now: NOW }, 2);

    expect(ids(ranked)).toEqual(['start', 'inside']);
    expect(ranked[0]?.parts.title).toBe(REFERENCE_WEIGHTS.titleWordStart);
    expect(ranked[1]?.parts.title).toBe(REFERENCE_WEIGHTS.titleContains);
  });

  it('gives a small boost to items this note already links to', () => {
    const pool = padded([candidate('new', 'Plan A'), candidate('linked', 'Plan B')]);

    const ranked = rankReferences(
      pool,
      {
        query: 'plan',
        linkedHere: new Set(['linked']),
        now: NOW,
      },
      2,
    );

    expect(ids(ranked)).toEqual(['linked', 'new']);
    expect(ranked[0]?.parts.linkedHere).toBe(REFERENCE_WEIGHTS.linkedHere);
  });

  it('breaks exact ties by server order, so the result is deterministic', () => {
    const pool = [candidate('x', 'Same'), candidate('y', 'Same')];
    const frecency = new Map([
      ['x', 2],
      ['y', 2],
    ]);

    // Different priors already separate them; equal everything else keeps the server's choice.
    expect(ids(rankReferences(pool, { query: 'same', frecency, now: NOW }))).toEqual(['x', 'y']);
  });

  it('drops duplicate ids, keeping the first', () => {
    const pool = [candidate('a', 'One'), candidate('a', 'One again'), candidate('b', 'Two')];

    expect(ids(rankReferences(pool, { query: '', now: NOW }))).toEqual(['a', 'b']);
  });

  it('explains every score as the sum of its parts', () => {
    const pool = [candidate('a', 'Plan', { updatedAt: new Date(NOW).toISOString() })];

    const [only] = rankReferences(pool, {
      query: 'plan',
      frecency: new Map([['a', 1]]),
      now: NOW,
    });
    const parts = only?.parts;

    expect(parts).toBeDefined();
    if (parts === undefined) return;
    const sum =
      parts.prior +
      parts.title +
      parts.frecency +
      parts.linkedHere +
      parts.nearby +
      parts.recency +
      parts.coCited;
    expect(only?.score).toBeCloseTo(sum);
    expect(parts.frecency).toBeCloseTo(REFERENCE_WEIGHTS.frecency * 0.5);
    expect(parts.recency).toBeCloseTo(REFERENCE_WEIGHTS.recency);
  });
});

describe('the signals a richer search will supply', () => {
  it('counts siblings, children and the parent of this note as nearby', () => {
    const pool = [
      candidate('far', 'Plan far', { parentId: 'elsewhere' }),
      candidate('sibling', 'Plan sibling', { parentId: 'folder' }),
      candidate('child', 'Plan child', { parentId: 'note' }),
      candidate('folder', 'Plan folder', { parentId: null }),
    ];

    const ranked = rankReferences(pool, {
      query: 'plan',
      currentItemId: 'note',
      currentParentId: 'folder',
      now: NOW,
    });

    expect(ranked.find((entry) => entry.candidate.id === 'far')?.parts.nearby).toBe(0);
    for (const id of ['sibling', 'child', 'folder']) {
      expect(ranked.find((entry) => entry.candidate.id === id)?.parts.nearby).toBe(
        REFERENCE_WEIGHTS.nearby,
      );
    }
  });

  it('halves recency every half-life and ignores an unreadable timestamp', () => {
    const pool = [
      candidate('old', 'Plan', { updatedAt: new Date(NOW - RECENCY_HALF_LIFE_MS).toISOString() }),
      candidate('bad', 'Plan', { updatedAt: 'not a date' }),
    ];

    const ranked = rankReferences(pool, { query: 'plan', now: NOW });

    expect(ranked.find((entry) => entry.candidate.id === 'old')?.parts.recency).toBeCloseTo(
      REFERENCE_WEIGHTS.recency / 2,
    );
    expect(ranked.find((entry) => entry.candidate.id === 'bad')?.parts.recency).toBe(0);
  });

  it('normalises co-citation to the strongest candidate in the pool', () => {
    const pool = [candidate('weak', 'Plan weak'), candidate('strong', 'Plan strong')];

    const ranked = rankReferences(pool, {
      query: 'plan',
      coCited: new Map([
        ['weak', 1],
        ['strong', 4],
      ]),
      now: NOW,
    });

    expect(ids(ranked)).toEqual(['strong', 'weak']);
    expect(ranked[0]?.parts.coCited).toBeCloseTo(REFERENCE_WEIGHTS.coCited);
    expect(ranked[1]?.parts.coCited).toBeCloseTo(REFERENCE_WEIGHTS.coCited / 4);
  });
});
