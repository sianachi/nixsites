import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { blueprintSchema } from '../blueprint/schema.js';
import { validateBlueprint } from '../blueprint/validate.js';
import { chatCaseSchema, chatSuiteSchema } from './chat-schema.js';

describe('chat review evaluation contract', () => {
  it('keeps every fixture buildable and every suite reference local to its fixture', () => {
    const nodesOf = new Map<string | undefined, Set<string>>();
    for (const name of [undefined, 'views', 'search']) {
      const file = name ? `fixture-${name}.json` : 'fixture.json';
      const raw = readFileSync(
        new URL(`../../evals/chat/${file}`, import.meta.url),
        'utf8',
      ).replaceAll(/\{today(?:[+-]\d+)?\}/g, '2026-10-09');
      const fixture = blueprintSchema.parse(JSON.parse(raw));
      const report = validateBlueprint(fixture, { inheritedFields: [], today: '2026-10-09' });
      expect(report.problems, file).toEqual([]);
      expect(report.ok).toBe(true);
      const nodes = new Set<string>();
      const collect = (node: typeof fixture.root) => {
        nodes.add(node.id);
        for (const child of node.children ?? []) collect(child);
      };
      collect(fixture.root);
      nodesOf.set(name, nodes);
    }
    const cases = chatSuiteSchema.parse(
      JSON.parse(readFileSync(new URL('../../evals/chat/cases.json', import.meta.url), 'utf8')),
    );
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    for (const entry of cases) {
      const nodes = nodesOf.get(entry.fixture);
      expect(nodes, `${entry.id} names an unknown fixture`).toBeDefined();
      const has = (ref: string) => {
        expect(nodes?.has(ref), `${entry.id}: ${ref}`).toBe(true);
      };
      if (entry.templateSource !== undefined) has(entry.templateSource);
      for (const match of entry.prompt.matchAll(/\{node:([^}]+)\}/g)) has(match[1] ?? '');
      for (const ref of entry.answerChecks?.references ?? []) has(ref);
      for (const ref of entry.answerChecks?.cites ?? []) has(ref);
      if (entry.currentItem !== undefined) has(entry.currentItem);
      for (const assertion of entry.asserts) {
        if ('item' in assertion) has(assertion.item);
        if ('parent' in assertion) has(assertion.parent);
        for (const match of JSON.stringify(assertion).matchAll(/\{item:([^}]+)\}/g))
          has(match[1] ?? '');
      }
    }
  });

  it('accepts an open note and cited items, and refuses ones that are not node names', () => {
    const parsed = chatCaseSchema.parse({
      id: 'context',
      prompt: 'What did we decide here?',
      currentItem: 'meeting-note',
      answerChecks: { cites: ['meeting-note'] },
    });
    expect(parsed.currentItem).toBe('meeting-note');
    expect(parsed.answerChecks?.cites).toEqual(['meeting-note']);
    expect(
      chatCaseSchema.parse({ id: 'plain', prompt: 'Hello', answerChecks: {} }).answerChecks?.cites,
    ).toEqual([]);
    for (const bad of [{ currentItem: 'Meeting Note' }, { answerChecks: { cites: ['/w/x'] } }])
      expect(chatCaseSchema.safeParse({ id: 'bad', prompt: 'Hello', ...bad }).success).toBe(false);
  });

  it('rejects contradictory review approvals and malformed bounded patterns', () => {
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        noWrites: true,
        approvedOperations: ['update_view'],
      }).success,
    ).toBe(false);
    for (const assertion of [
      { kind: 'child', parent: 'home', title: '[' },
      { kind: 'child', parent: 'home', title: 'Demo', noteContains: '[' },
      { kind: 'note', item: 'home', contains: '[' },
    ])
      expect(
        chatCaseSchema.safeParse({ id: 'review', prompt: 'Review', asserts: [assertion] }).success,
      ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        workspaceAccess: false,
        approvedOperations: ['update_view'],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        approvedOperations: ['delete_permanently'],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({ id: 'review', prompt: 'Review', answerChecks: { all: ['['] } })
        .success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        feedbackChecks: [{ code: 'missing-tool', matches: '[' }],
      }).success,
    ).toBe(false);
    expect(
      chatCaseSchema.safeParse({
        id: 'review',
        prompt: 'Review',
        answerChecks: { all: Array<string>(9).fill('date') },
      }).success,
    ).toBe(false);
  });
});
