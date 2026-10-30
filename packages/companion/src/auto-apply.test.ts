import { describe, expect, it } from 'vitest';
import { canApplyWithoutAsking, hasExternalLink } from './auto-apply.js';
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

  it('lets ordinary text, item links and slashes through', () => {
    expect(hasExternalLink(['Weekly plan', '/w/123?item=456', 'a / b', 'http not a link'])).toBe(
      false,
    );
    expect(hasExternalLink([])).toBe(false);
  });
});
