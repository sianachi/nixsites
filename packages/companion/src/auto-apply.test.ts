import { describe, expect, it } from 'vitest';
import { canApplyWithoutAsking, hasExternalLink, mayApplyUnasked } from './auto-apply.js';
import { READ_ONLY_OPERATIONS, workspaceToolSchema } from './tool-args.js';

const everyOperation = workspaceToolSchema.shape.operation.options;
const alwaysAsk = [
  'trash_item',
  'move_item',
  'save_as_template',
  'update_view',
  'edit_fields',
  'run_action',
] as const;

describe('canApplyWithoutAsking', () => {
  it('never answers for a read: reads have their own switch', () => {
    for (const operation of READ_ONLY_OPERATIONS)
      expect(canApplyWithoutAsking(operation)).toBe(false);
  });

  it('keeps the audience-changing writes asking and lets every other write run', () => {
    for (const operation of alwaysAsk) expect(canApplyWithoutAsking(operation)).toBe(false);
    const writes = everyOperation.filter(
      (operation) =>
        !READ_ONLY_OPERATIONS.has(operation) &&
        !(alwaysAsk as readonly string[]).includes(operation),
    );
    expect(writes.length).toBeGreaterThan(5);
    for (const operation of writes) expect(canApplyWithoutAsking(operation)).toBe(true);
  });

  it('runs a task completion without asking but never a calendar read through this switch', () => {
    // Completing a task changes no one's access, so it is not an always-ask write; reading the
    // calendar is a read and governed by the reads switch.
    expect(canApplyWithoutAsking('complete_task')).toBe(true);
    expect(READ_ONLY_OPERATIONS.has('read_calendar')).toBe(true);
    expect(canApplyWithoutAsking('read_calendar')).toBe(false);
  });
});

describe('hasExternalLink', () => {
  it('finds links to another host in any form the editor would keep', () => {
    expect(hasExternalLink(['see https://example.test/p?d=secret'])).toBe(true);
    expect(hasExternalLink(['![](http://example.test/a.png)'])).toBe(true);
    expect(hasExternalLink(['<//example.test/x>'])).toBe(true);
    expect(hasExternalLink(['plain', 'HTTPS://EXAMPLE.TEST'])).toBe(true);
  });

  it('finds scheme URLs written without the double slash', () => {
    for (const text of [
      '![x](https:evil.test/p.png?d=1)',
      '![x](https:/evil.test/p.png)',
      '![x](https:\\\\evil.test/p.png)',
      '![x](https&#58;evil.test/p.png)',
      '[x](https:evil.test)',
    ]) {
      expect(hasExternalLink([text]), text).toBe(true);
    }
  });

  it('lets ordinary text, item links and slashes through', () => {
    expect(hasExternalLink(['Weekly plan', '/w/123?item=456', 'a / b', 'http not a link'])).toBe(
      false,
    );
    expect(hasExternalLink([])).toBe(false);
  });
});

describe('mayApplyUnasked', () => {
  const base = workspaceToolSchema.parse({
    operation: 'append_note',
    itemId: '0192f0e0-0000-7000-8000-000000000002',
    parentId: '',
    title: '',
    markdown: 'Hi',
    query: '',
    propertiesJson: '',
    specJson: '',
  });
  it('allows a plain write, and refuses a protected read, a link or an always-ask operation', () => {
    expect(mayApplyUnasked(base, false)).toBe(true);
    expect(mayApplyUnasked(base, true)).toBe(false);
    expect(mayApplyUnasked({ ...base, markdown: 'https://example.test/x' }, false)).toBe(false);
    expect(mayApplyUnasked({ ...base, title: 'https://example.test/x' }, false)).toBe(false);
    expect(mayApplyUnasked({ ...base, operation: 'trash_item' }, false)).toBe(false);
  });
});
