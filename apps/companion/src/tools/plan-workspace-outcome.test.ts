import { describe, expect, it } from 'vitest';
import { workspacePlanOutcome } from './plan-workspace-outcome.ts';

describe('bounded workspace execution outcomes', () => {
  it.each([
    ['build_blueprint', '{"complete":true,"ledger":[{"status":"done"}]}', 'completed'],
    [
      'build_blueprint',
      '{"complete":false,"ledger":[{"status":"done"},{"status":"failed"}]}',
      'partial',
    ],
    ['create_note', '{"created":true,"contentConfirmed":false,"id":"created-note"}', 'unknown'],
    ['save_as_template', '{"templateId":"saved","restoreFailures":["sample-row"]}', 'partial'],
    ['rename_item', '{"id":"renamed","title":"New title"}', 'completed'],
    ['build_blueprint', '{"truncated":true,"preview":"partial ledger"}', 'unknown'],
    ['list_templates', '{"truncated":true,"templates":[]}', 'completed'],
  ])('classifies %s using its observed receipt', (operation, text, expected) => {
    expect(workspacePlanOutcome(operation, text)).toBe(expected);
  });
});
