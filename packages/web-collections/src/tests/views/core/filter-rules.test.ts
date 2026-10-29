import { describe, expect, it } from 'vitest';

import {
  filterGroup,
  type PropertyOwner,
  type ViewFilterCondition,
  type ViewFilterRule,
} from '../../../core/container-model';
import { applyRules, evaluateRule, type RuleContext } from '../../../core/filter-rules';

const CONTEXT: RuleContext = { today: '2026-10-01', principalId: 'principal-me' };

function owner(properties: Record<string, unknown>): PropertyOwner {
  return { title: 'Item', properties };
}

function rule(property: string, operator: string, value = ''): ViewFilterCondition {
  return { property, operator, value };
}

describe('client-side filter rules', () => {
  it('matches equals against strings, numbers, checkboxes and multi-select members', () => {
    expect(evaluateRule(owner({ status: 'Open' }), rule('status', 'equals', 'Open'), CONTEXT)).toBe(
      true,
    );
    expect(evaluateRule(owner({ points: 3 }), rule('points', 'equals', '3'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ done: true }), rule('done', 'equals', 'true'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ tags: ['a', 'b'] }), rule('tags', 'equals', 'b'), CONTEXT)).toBe(
      true,
    );
    expect(
      evaluateRule(owner({ status: 'Open' }), rule('status', 'equals', 'Closed'), CONTEXT),
    ).toBe(false);
  });

  it('treats an absent property as not equal, as the server does', () => {
    expect(evaluateRule(owner({}), rule('done', 'not-equals', 'true'), CONTEXT)).toBe(true);
  });

  it('resolves me to the signed-in principal, and to nobody while that is unknown', () => {
    const assigned = owner({ owner: 'principal-me' });

    expect(evaluateRule(assigned, rule('owner', 'equals', 'me'), CONTEXT)).toBe(true);
    expect(
      evaluateRule(assigned, rule('owner', 'equals', 'me'), { ...CONTEXT, principalId: null }),
    ).toBe(false);
  });

  it('compares days, resolving today and reading a timestamp by its local day', () => {
    const due = owner({ due: '2026-09-30' });
    const meeting = owner({ at: '2026-10-01T23:30:00-07:00[America/Los_Angeles]' });

    expect(evaluateRule(due, rule('due', 'before', 'today'), CONTEXT)).toBe(true);
    expect(evaluateRule(due, rule('due', 'on-or-after', 'today'), CONTEXT)).toBe(false);
    expect(evaluateRule(meeting, rule('at', 'on', '2026-10-01'), CONTEXT)).toBe(true);
  });

  it('includes both ends of within-next', () => {
    expect(
      evaluateRule(owner({ due: '2026-10-01' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-10-08' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-10-09' }), rule('due', 'within-next', '7'), CONTEXT),
    ).toBe(false);
  });

  it('compares numbers numerically and refuses a blank literal', () => {
    expect(
      evaluateRule(owner({ amount: 1.5 }), rule('amount', 'greater-than', '1.25'), CONTEXT),
    ).toBe(true);
    expect(evaluateRule(owner({ amount: -10 }), rule('amount', 'less-than', '-5'), CONTEXT)).toBe(
      true,
    );
    expect(evaluateRule(owner({ amount: 1 }), rule('amount', 'greater-than', ''), CONTEXT)).toBe(
      false,
    );
  });

  it('reads contains case-insensitively and empty as absent, blank or an empty list', () => {
    expect(
      evaluateRule(owner({ name: 'Quarterly Plan' }), rule('name', 'contains', 'plan'), CONTEXT),
    ).toBe(true);
    expect(evaluateRule(owner({ tags: [] }), rule('tags', 'is-empty'), CONTEXT)).toBe(true);
    expect(evaluateRule(owner({ name: '' }), rule('name', 'is-not-empty'), CONTEXT)).toBe(false);
  });

  it('admits everything for an operator this build does not know', () => {
    expect(evaluateRule(owner({}), rule('x', 'some-future-operator', 'v'), CONTEXT)).toBe(true);
  });

  it('ANDs rules together and returns the same array when there are none', () => {
    const items = [owner({ status: 'Open', points: 3 }), owner({ status: 'Open', points: 1 })];

    expect(applyRules(items, [], CONTEXT)).toBe(items);
    expect(
      applyRules(
        items,
        [rule('status', 'equals', 'Open'), rule('points', 'greater-than', '2')],
        CONTEXT,
      ),
    ).toEqual([items[0]]);
  });

  it('reads contains as a case-insensitive substring of text', () => {
    const named = owner({ name: 'Quarterly Plan' });

    expect(evaluateRule(named, rule('name', 'contains', 'PLAN'), CONTEXT)).toBe(true);
    expect(evaluateRule(named, rule('name', 'contains', 'arter'), CONTEXT)).toBe(true);
    expect(evaluateRule(named, rule('name', 'not-contains', 'plan'), CONTEXT)).toBe(false);
    expect(evaluateRule(owner({}), rule('name', 'not-contains', 'plan'), CONTEXT)).toBe(true);
  });

  it('reads contains on a multi-select as exact option membership, as the server documents it', () => {
    const tagged = owner({ tags: ['Urgent', 'Home'] });

    expect(evaluateRule(tagged, rule('tags', 'contains', 'Urgent'), CONTEXT)).toBe(true);
    // Neither a fragment of an option nor another spelling of it is that option.
    expect(evaluateRule(tagged, rule('tags', 'contains', 'Urg'), CONTEXT)).toBe(false);
    expect(evaluateRule(tagged, rule('tags', 'contains', 'urgent'), CONTEXT)).toBe(false);
    expect(evaluateRule(tagged, rule('tags', 'not-contains', 'Work'), CONTEXT)).toBe(true);
  });

  it('reads within-last as the window back to today, both ends included', () => {
    // CONTEXT's today is 2026-10-01.
    expect(
      evaluateRule(owner({ due: '2026-09-24' }), rule('due', 'within-last', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-10-01' }), rule('due', 'within-last', '7'), CONTEXT),
    ).toBe(true);
    expect(
      evaluateRule(owner({ due: '2026-09-23' }), rule('due', 'within-last', '7'), CONTEXT),
    ).toBe(false);
    expect(
      evaluateRule(owner({ due: '2026-10-02' }), rule('due', 'within-last', '7'), CONTEXT),
    ).toBe(false);
  });

  it.each([
    ['start-of-week', '2026-09-28'],
    ['start-of-month', '2026-10-01'],
    ['same-day-last-week', '2026-09-24'],
    ['same-day-last-month', '2026-09-01'],
  ])("resolves %s from the reader's today, as the server does", (token, day) => {
    expect(evaluateRule(owner({ due: day }), rule('due', 'on', token), CONTEXT)).toBe(true);
  });

  it('clamps same-day-last-month to the shorter month', () => {
    const context: RuleContext = { today: '2026-03-31', principalId: null };

    expect(
      evaluateRule(owner({ due: '2026-02-28' }), rule('due', 'on', 'same-day-last-month'), context),
    ).toBe(true);
  });

  it('admits an item an any-of group admits through any one of its conditions', () => {
    const items = [
      owner({ status: 'Doing', points: 1 }),
      owner({ status: 'Blocked', points: 1 }),
      owner({ status: 'Done', points: 9 }),
      owner({ status: 'Done', points: 1 }),
    ];
    const group: ViewFilterRule = filterGroup([
      rule('status', 'equals', 'Doing'),
      rule('status', 'equals', 'Blocked'),
      rule('points', 'greater-than', '5'),
    ]);

    expect(applyRules(items, [group], CONTEXT)).toEqual([items[0], items[1], items[2]]);
    expect(applyRules(items, [group, rule('status', 'not-equals', 'Done')], CONTEXT)).toEqual([
      items[0],
      items[1],
    ]);
  });
});
