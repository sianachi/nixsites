import { describe, expect, it } from 'vitest';

import { IDS, request } from '../testing/testing.ts';
import { TASK_PLAN_INSTRUCTIONS, taskPlanInput } from './task-plan.ts';

const context = (value: unknown) =>
  request({
    text: 'Rename the release brief and add the checklist',
    sharedText: '[{"name":"workspace.rename_item","description":"Rename an item"}]',
    contextText: JSON.stringify(value),
  });

describe('whole-plan planner input', () => {
  it('accepts an explicitly workspace-anchored task without inventing an item ID', () => {
    const input = taskPlanInput(
      context({ taskId: null, workspaceId: IDS.workspace, observations: [] }),
    );

    expect(input).toBeDefined();
    expect(JSON.parse(input ?? '{}')).toMatchObject({
      taskId: null,
      workspaceId: IDS.workspace,
    });
  });

  it('keeps the workspace identity in item-anchored plan input', () => {
    const input = taskPlanInput(
      context({ taskId: IDS.item, workspaceId: IDS.workspace, observations: [] }),
    );

    expect(JSON.parse(input ?? '{}')).toMatchObject({
      taskId: IDS.item,
      workspaceId: IDS.workspace,
    });
  });

  it.each([
    { taskId: null, observations: [] },
    { taskId: null, workspaceId: IDS.other, observations: [] },
    { taskId: IDS.item, workspaceId: IDS.other, observations: [] },
    { taskId: null, workspaceId: IDS.workspace, observations: [], approve: true },
  ])('refuses missing, changed or extra workspace context %#', (value) => {
    expect(taskPlanInput(context(value))).toBeUndefined();
  });

  it('asks for a bounded concrete plan and keeps owner consent outside model output', () => {
    expect(TASK_PLAN_INSTRUCTIONS).toContain('"kind":"plan"');
    expect(TASK_PLAN_INSTRUCTIONS).toContain('1 to 12');
    expect(TASK_PLAN_INSTRUCTIONS).toContain('Only Nix can approve or run actions.');
  });
});
