import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  executeCreateAutomation,
  executeDeleteAutomation,
  executeGetAutomation,
  executeListAutomationRuns,
  executeListAutomations,
  executeRunAutomation,
  executeSetAutomationEnabled,
  executeTestAutomation,
  executeUpdateAutomation,
  type RulePatch,
} from './commands/automations.ts';
import {
  identifier,
  jsonObjectInput,
  ruleDocumentInput,
  RULE_GRAMMAR,
  toolResult,
} from './mcp-support.ts';
import type { McpToolDeps } from './mcp-support.ts';

export function registerAutomationTools(server: McpServer, { session }: McpToolDeps): void {
  server.registerTool(
    'list_automations',
    {
      description: 'List your own automation rules in a workspace.',
      inputSchema: { workspaceId: identifier },
    },
    ({ workspaceId }) =>
      toolResult(async () => ({
        items: await executeListAutomations(await session(), workspaceId),
      })),
  );

  server.registerTool(
    'get_automation',
    { description: 'Read one of your automation rules.', inputSchema: { ruleId: identifier } },
    ({ ruleId }) => toolResult(async () => executeGetAutomation(await session(), ruleId)),
  );

  server.registerTool(
    'create_automation',
    {
      description: `Create an automation rule. Writes need the admin access scope (choose it when you create the access credential in Settings). ${RULE_GRAMMAR}`,
      inputSchema: {
        workspaceId: identifier,
        name: z.string().trim().min(1).max(200),
        enabled: z.boolean().default(true),
        scopeItemId: identifier.nullable().default(null),
        trigger: jsonObjectInput,
        conditions: ruleDocumentInput.conditions,
        actions: ruleDocumentInput.actions.unwrap(),
      },
    },
    ({ workspaceId, name, enabled, scopeItemId, trigger, conditions, actions }) =>
      toolResult(async () => {
        return executeCreateAutomation(await session(), workspaceId, {
          name,
          enabled,
          scopeItemId,
          trigger,
          conditions: conditions ?? [],
          actions,
        });
      }),
  );

  server.registerTool(
    'update_automation',
    {
      description:
        'Change an automation rule: given members replace the stored ones. Saves behind expectedRevision, else the current revision. Writes need the admin access scope (choose it when you create the access credential in Settings).',
      inputSchema: {
        ruleId: identifier,
        expectedRevision: z.number().int().min(0).optional(),
        name: z.string().trim().min(1).max(200).optional(),
        enabled: z.boolean().optional(),
        scopeItemId: identifier.nullable().optional(),
        ...ruleDocumentInput,
      },
    },
    ({ ruleId, expectedRevision, ...members }) =>
      toolResult(async () => {
        const patch: RulePatch = {};
        if (members.name !== undefined) patch.name = members.name;
        if (members.enabled !== undefined) patch.enabled = members.enabled;
        if (members.scopeItemId !== undefined) patch.scopeItemId = members.scopeItemId;
        if (members.trigger !== undefined) patch.trigger = members.trigger;
        if (members.conditions !== undefined) patch.conditions = members.conditions;
        if (members.actions !== undefined) patch.actions = members.actions;
        if (Object.keys(patch).length === 0) throw new Error('Nothing to change.');
        return executeUpdateAutomation(await session(), ruleId, patch, expectedRevision);
      }),
  );

  server.registerTool(
    'set_automation_enabled',
    {
      description:
        'Switch an automation rule on or off. Enabling clears an automatic disable. Writes need the admin access scope (choose it when you create the access credential in Settings).',
      inputSchema: { ruleId: identifier, enabled: z.boolean() },
    },
    ({ ruleId, enabled }) =>
      toolResult(async () => executeSetAutomationEnabled(await session(), ruleId, enabled)),
  );

  server.registerTool(
    'delete_automation',
    {
      description:
        'Delete an automation rule and its run log. Requires explicit confirmation and the admin access scope (choose it when you create the access credential in Settings).',
      inputSchema: { ruleId: identifier, confirm: z.boolean() },
    },
    ({ ruleId, confirm }) =>
      toolResult(async () => {
        if (!confirm) throw new Error('Set confirm: true to delete this automation.');
        return executeDeleteAutomation(await session(), ruleId);
      }),
  );

  server.registerTool(
    'list_automation_runs',
    {
      description:
        "One page of an automation rule's run log, newest first: status, reason code, origin and item.",
      inputSchema: { ruleId: identifier, cursor: z.string().max(512).optional() },
    },
    ({ ruleId, cursor }) =>
      toolResult(async () => executeListAutomationRuns(await session(), ruleId, cursor)),
  );

  server.registerTool(
    'run_automation',
    {
      description:
        'Run an automation rule now, as you, optionally on a triggering item. Writes need the admin access scope (choose it when you create the access credential in Settings).',
      inputSchema: { ruleId: identifier, itemId: identifier.optional() },
    },
    ({ ruleId, itemId }) =>
      toolResult(async () => executeRunAutomation(await session(), ruleId, itemId)),
  );

  server.registerTool(
    'test_automation',
    {
      description:
        'Dry-run an automation rule: whether it would run now and previews of its actions. Writes nothing, but needs the admin access scope (choose it when you create the access credential in Settings).',
      inputSchema: { ruleId: identifier, itemId: identifier.optional() },
    },
    ({ ruleId, itemId }) =>
      toolResult(async () => executeTestAutomation(await session(), ruleId, itemId)),
  );
}
