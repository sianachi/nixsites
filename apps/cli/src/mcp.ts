/** Workspace administration tools exposed over the Model Context Protocol. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTemplateDraftTools } from './mcp-template-drafts.ts';
import { registerWorkspaceTools } from './mcp-workspaces.ts';
import { registerFinanceTools } from './mcp-finance.ts';
import { registerHabitAndCommentTools } from './mcp-habits-comments.ts';
import { registerMemberTools } from './mcp-members.ts';
import { registerConversationMcpTools } from './mcp-conversations.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  files,
  items,
  notifications,
  search,
  structure,
  templates as templateResources,
  templateInitializationSchema,
  callOperation,
  findOperations,
  isHumanOnlyOperation,
  operationById,
  operationRisk,
} from '@nix/api-client';
import { downloadFileValue, uploadFileValue } from './commands/files.ts';
import { runImport } from './commands/import.ts';
import {
  cancelDocumentImportFromSession,
  commitDocumentImportFromSession,
  getDocumentImportFromSession,
} from './commands/document-import.ts';
import {
  executeTemplateApply,
  executeTemplateArchiveCommit,
  executeTemplateArchiveExport,
  executeTemplateImportGet,
  executeTemplateArchivePreview,
  executeTemplateCapture,
  executeTemplateOperationResume,
  executeTemplateInitializationUpdate,
} from './commands/templates.ts';
import { executePetRuntime, executePetToolRun } from './commands/pets.ts';
import { readStructureForSession } from './commands/structure.ts';
import { evaluateBlueprint, executeBlueprintBuild } from './commands/blueprint.ts';
import { requireAccessToken, resolveSession, type SessionDeps } from './commands/shared.ts';
import { readBodyMarkdown, writeBodyMarkdown } from './body.ts';
import { listNamedVersions, listRevisions, nameVersion, restoreRevision } from './history.ts';
import {
  executeListNotifications,
  executeReadAllNotifications,
  executeReadNotification,
  executeSetPreferences,
  parsePreferenceFlags,
} from './commands/notifications.ts';
import { executeClearReminder, executeSetReminder } from './commands/reminders.ts';
import { executeProtect } from './commands/protection.ts';
import {
  executeLinkLog,
  executeListLinks,
  executeSyncLink,
  executeUnlink,
} from './commands/calendar-sync.ts';
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
  RULE_GRAMMAR,
  identifier,
  jsonObjectInput,
  petSessionForMcp,
  ruleDocumentInput,
  toolResult,
} from './mcp-support.ts';
import type { Session } from './session.ts';

export interface WorkspaceMcpOptions {
  readonly transport?: 'stdio' | 'http';
  readonly profileName?: string;
  readonly sessionDeps?: SessionDeps;
  readonly resolve?: (profileName: string | undefined, deps: SessionDeps) => Promise<Session>;
}

/** Creates the MCP server without binding a transport, so protocol tests can use an in-memory pair. */
export async function createWorkspaceMcpServer(
  options: WorkspaceMcpOptions = {},
): Promise<McpServer> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const server = new McpServer({ name: 'nixctl', version: '0.5.1' });
  const resolver = options.resolve ?? resolveSession;
  const session = lazy(() => resolver(options.profileName, options.sessionDeps ?? {}));
  const deps = { session, options };

  registerTemplateDraftTools(server, deps);
  registerWorkspaceTools(server, deps);
  registerFinanceTools(server, deps);
  registerHabitAndCommentTools(server, deps);
  registerMemberTools(server, deps);
  const importDocument = server.registerTool(
    'import_document',
    {
      description:
        'Import a local PDF, DOCX, UTF-8 TXT, Markdown file, or Markdown folder as editable Nix notes.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
        preview: z.boolean().default(false),
        wait: z.boolean().default(true),
      },
    },
    ({ workspaceId, path, parentId, preview, wait }) =>
      toolResult(async () => {
        let result: unknown;
        await runImport(
          options.profileName,
          {
            workspaceId,
            path,
            dryRun: preview,
            noWait: !wait,
            ...(parentId === undefined ? {} : { parentId }),
          },
          { json: true, isTty: false },
          options.sessionDeps ?? {},
          {
            writeResult: (value) => {
              result = value;
            },
            setExitCode: false,
            onDocumentImportStarted: () => undefined,
          },
        );
        return result;
      }),
  );

  server.registerTool(
    'get_document_import',
    {
      description: 'Read durable state for a document import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) =>
      toolResult(async () => getDocumentImportFromSession(await session(), importId)),
  );

  server.registerTool(
    'commit_document_import',
    {
      description:
        'Commit a preview-ready document import, optionally returning before completion.',
      inputSchema: { importId: identifier, wait: z.boolean().default(true) },
    },
    ({ importId, wait }) =>
      toolResult(async () => commitDocumentImportFromSession(await session(), importId, wait)),
  );

  server.registerTool(
    'cancel_document_import',
    {
      description: 'Cancel a document import after explicit confirmation.',
      inputSchema: { importId: identifier, confirm: z.literal(true) },
    },
    ({ importId }) =>
      toolResult(async () => cancelDocumentImportFromSession(await session(), importId)),
  );

  const uploadFile = server.registerTool(
    'upload_file',
    {
      description:
        'Upload a local file as an opaque child item. Uploaded files are not malware-scanned.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().min(1),
        parentId: identifier.optional(),
      },
    },
    ({ workspaceId, path, parentId }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, ...(parentId === undefined ? {} : { parentId }) },
          options.sessionDeps ?? {},
        ),
      ),
  );

  const replaceFile = server.registerTool(
    'replace_file',
    {
      description: 'Upload a new immutable current version for an existing file item.',
      inputSchema: { workspaceId: identifier, itemId: identifier, path: z.string().min(1) },
    },
    ({ workspaceId, itemId, path }) =>
      toolResult(() =>
        uploadFileValue(
          options.profileName,
          { workspaceId, path, targetItemId: itemId },
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'list_file_versions',
    {
      description: 'List file metadata and immutable versions for a visible file item.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => (await session()).client.query(files.fileByItem(itemId))),
  );

  const downloadFile = server.registerTool(
    'download_file',
    {
      description: 'Download a current or historical file version to a local path.',
      inputSchema: {
        itemId: identifier,
        outputPath: z.string().min(1),
        versionId: identifier.optional(),
      },
    },
    ({ itemId, outputPath, versionId }) =>
      toolResult(() =>
        downloadFileValue(
          options.profileName,
          itemId,
          outputPath,
          versionId,
          options.sessionDeps ?? {},
        ),
      ),
  );

  server.registerTool(
    'list_templates',
    {
      description: 'List templates visible in a workspace, including their setup metadata.',
      inputSchema: { workspaceId: identifier },
    },
    ({ workspaceId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.listTemplates(workspaceId)),
      ),
  );

  server.registerTool(
    'get_template',
    {
      description: 'Read a template, its item tree, and its initialization questions and rules.',
      inputSchema: { templateId: identifier },
    },
    ({ templateId }) =>
      toolResult(async () =>
        (await session()).client.query(templateResources.templateById(templateId)),
      ),
  );

  server.registerTool(
    'capture_template',
    {
      description: 'Capture a readable item subtree as a reusable workspace template.',
      inputSchema: {
        workspaceId: identifier,
        sourceItemId: identifier,
        title: z.string().trim().min(1).max(200),
        description: z.string().max(4_096).nullable().optional(),
        includeBody: z.boolean().default(false),
        includeChildren: z.boolean().default(false),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      workspaceId,
      sourceItemId,
      title,
      description,
      includeBody,
      includeChildren,
      idempotencyKey,
    }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-capture:${sourceItemId}:${randomUUID()}`;
        const request = {
          workspaceId,
          sourceItemId,
          title,
          ...(description === undefined ? {} : { description }),
          includeBody,
          includeChildren,
          idempotencyKey: key,
        };
        const result = await executeTemplateCapture(await session(), request, false);
        return {
          capture: result,
          resume: result.fileTransferPending
            ? {
                kind: 'capture',
                jobId: result.fileTransferJobId,
                operationId: result.operationId,
                idempotencyKey: key,
                request,
              }
            : { idempotencyKey: key, request },
        };
      }),
  );

  server.registerTool(
    'preflight_template_application',
    {
      description:
        'Resolve inputs and preview a template against an exact destination and revision.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
      },
    },
    ({ templateId, mode, targetItemId, parentItemId, title, inputs, expectedRevision }) =>
      toolResult(async () => {
        const current = await session();
        const detail = await current.client.query(templateResources.templateById(templateId));
        return current.client.execute(
          templateResources.preflightTemplate(templateId, {
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            expectedRevision: expectedRevision ?? detail.revision,
          }),
        );
      }),
  );

  server.registerTool(
    'apply_template',
    {
      description:
        'Preflight and apply a template; the server checks permissions and resolves links.',
      inputSchema: {
        templateId: identifier,
        mode: z.enum(['merge', 'create']),
        targetItemId: identifier.nullable().optional(),
        parentItemId: identifier.nullable().optional(),
        title: z.string().max(200).optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        expectedRevision: z.number().int().nonnegative().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({
      templateId,
      mode,
      targetItemId,
      parentItemId,
      title,
      inputs,
      expectedRevision,
      idempotencyKey,
    }) =>
      toolResult(async () =>
        executeTemplateApply(
          await session(),
          {
            templateId,
            mode,
            ...(targetItemId === undefined ? {} : { targetItemId }),
            ...(parentItemId === undefined ? {} : { parentItemId }),
            ...(title === undefined ? {} : { title }),
            ...(inputs === undefined ? {} : { inputs }),
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          },
          randomUUID,
          { waitForFileTransfer: false },
        ),
      ),
  );

  server.registerTool(
    'set_template_initialization',
    {
      description:
        'Author setup questions, per-field rules, and external reference policies, then save the template draft.',
      inputSchema: {
        templateId: identifier,
        initialization: z.record(z.string(), z.unknown()),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(4_096).nullable().optional(),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ templateId, initialization, title, description, idempotencyKey }) =>
      toolResult(async () => {
        const parsed = templateInitializationSchema.parse(initialization);
        const key = idempotencyKey ?? `nixctl-mcp-edit:${templateId}:${randomUUID()}`;
        return executeTemplateInitializationUpdate(
          await session(),
          templateId,
          parsed,
          {
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            idempotencyKey: key,
          },
          randomUUID,
          false,
        );
      }),
  );

  const previewTemplateArchiveImport = server.registerTool(
    'preview_template_archive_import',
    {
      description:
        'Upload a local .nix template archive and validate its destination and digest before commit.',
      inputSchema: {
        workspaceId: identifier,
        path: z.string().trim().min(1).max(4_096),
        idempotencyKey: z.string().min(1).max(200).optional(),
      },
    },
    ({ workspaceId, path, idempotencyKey }) =>
      toolResult(async () => {
        const key = idempotencyKey ?? `nixctl-mcp-template-import:${randomUUID()}`;
        return executeTemplateArchivePreview(await session(), workspaceId, path, key);
      }),
  );

  server.registerTool(
    'get_template_archive_import',
    {
      description: 'Read the current state of an authorized template archive import.',
      inputSchema: { importId: identifier },
    },
    ({ importId }) => toolResult(async () => executeTemplateImportGet(await session(), importId)),
  );

  server.registerTool(
    'commit_template_archive_import',
    {
      description:
        'Publish a previewed template archive using its exact import ID and SHA-256 digest.',
      inputSchema: {
        importId: identifier,
        digest: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    ({ importId, digest }) =>
      toolResult(async () => executeTemplateArchiveCommit(await session(), importId, digest)),
  );

  const exportTemplateArchive = server.registerTool(
    'export_template_archive',
    {
      description:
        'Write a portable template archive to a local path and return its size and media type.',
      inputSchema: {
        templateId: identifier,
        path: z.string().trim().min(1).max(4_096),
      },
    },
    ({ templateId, path }) =>
      toolResult(async () => executeTemplateArchiveExport(await session(), templateId, path)),
  );

  server.registerTool(
    'resume_template_file_copy',
    {
      description:
        'Wait for a Core file-copy operation, then replay the original idempotent template command.',
      inputSchema: {
        kind: z.enum(['capture', 'apply', 'draft']),
        jobId: identifier,
        request: z.record(z.string(), z.unknown()),
      },
    },
    ({ kind, jobId, request }) =>
      toolResult(async () =>
        executeTemplateOperationResume(await session(), { kind, jobId, request }),
      ),
  );

  server.registerTool(
    'pet_runtime',
    {
      description:
        'Drive a pet companion runtime: status, connect, send, watch (long-poll for a change past `after`), tool_claim/tool_result, and settings. Uses a short-lived interactive session, never expanded PAT scopes.',
      inputSchema: {
        operation: z.enum([
          'status',
          'connect',
          'disconnect',
          'models',
          'read',
          'watch',
          'send',
          'interrupt',
          'reset',
          'settings',
          'tool_claim',
          'tool_result',
          'history',
          'read_history',
          'delete_history',
          'rename',
          'resume_history',
        ]),
        workspaceId: identifier.optional(),
        petId: identifier.optional(),
        rootItemId: identifier.optional(),
        allowEdits: z.boolean().optional(),
        historyId: identifier.optional(),
        title: z.string().max(120).optional(),
        message: z.string().max(20_000).optional(),
        model: z.string().max(160).optional(),
        workspaceTools: z.boolean().optional(),
        toolId: z.string().max(200).optional(),
        requestId: z.string().max(80).optional(),
        toolResult: z.string().max(32_000).optional(),
        toolSuccess: z.boolean().optional(),
        after: z.number().int().min(0).optional(),
        apiUrl: z.string().trim().min(1).optional(),
      },
    },
    (input) =>
      toolResult(async () => {
        const session = await petSessionForMcp(input.apiUrl, options);
        return executePetRuntime(session.client, input.operation, {
          ...(input.workspaceId ? { workspace: input.workspaceId } : {}),
          ...(input.petId ? { pet: input.petId } : {}),
          ...(input.rootItemId ? { rootItem: input.rootItemId } : {}),
          ...(input.allowEdits !== undefined ? { allowEdits: input.allowEdits } : {}),
          ...(input.historyId ? { historyId: input.historyId } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.workspaceTools !== undefined ? { workspaceTools: input.workspaceTools } : {}),
          ...(input.toolId !== undefined ? { toolId: input.toolId } : {}),
          ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
          ...(input.toolResult !== undefined ? { toolResult: input.toolResult } : {}),
          ...(input.toolSuccess !== undefined ? { toolSuccess: input.toolSuccess } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
        });
      }),
  );

  server.registerTool(
    'pet_tool_run',
    {
      description:
        'Preview, approve, or decline one pending companion workspace tool call, claiming before any write exactly as the web companion panel does. Uses a short-lived interactive session, never expanded PAT scopes.',
      inputSchema: {
        workspaceId: identifier,
        petId: identifier,
        rootItemId: identifier.optional(),
        allowEdits: z.boolean().optional(),
        toolId: z.string().max(200),
        decision: z.enum(['approve', 'decline', 'preview']),
        apiUrl: z.string().trim().min(1).optional(),
      },
    },
    ({ workspaceId, petId, toolId, decision, apiUrl, rootItemId, allowEdits }) =>
      toolResult(async () =>
        executePetToolRun(
          await petSessionForMcp(apiUrl, options),
          workspaceId,
          petId,
          toolId,
          decision,
          undefined,
          rootItemId ? { rootItemId, readOnly: !allowEdits } : undefined,
        ),
      ),
  );

  server.registerTool(
    'structure_read',
    {
      description: "Read an item's effective fields, views and bounded child count.",
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) => toolResult(async () => readStructureForSession(await session(), itemId)),
  );

  server.registerTool(
    'blueprint_validate',
    {
      description: 'Validate a blueprint without writing items.',
      inputSchema: { specJson: z.string().min(1), parentId: identifier.optional() },
    },
    ({ specJson, parentId }) =>
      toolResult(async () => {
        const raw: unknown = JSON.parse(specJson);
        const evaluated = await evaluateBlueprint(
          raw,
          { parent: parentId },
          parentId ? await session() : undefined,
        );
        return evaluated.report;
      }),
  );

  server.registerTool(
    'blueprint_describe',
    {
      description: 'Preview a blueprint without writing items.',
      inputSchema: { specJson: z.string().min(1), parentId: identifier.optional() },
    },
    ({ specJson, parentId }) =>
      toolResult(async () => {
        const raw: unknown = JSON.parse(specJson);
        const evaluated = await evaluateBlueprint(
          raw,
          { parent: parentId },
          parentId ? await session() : undefined,
        );
        return evaluated.preview ?? evaluated.report;
      }),
  );

  server.registerTool(
    'blueprint_build',
    {
      description: 'Build a validated blueprint as a draft. Requires explicit confirmation.',
      inputSchema: {
        specJson: z.string().min(1),
        parentId: identifier.optional(),
        workspaceId: identifier.optional(),
        confirm: z.boolean(),
      },
    },
    ({ specJson, parentId, workspaceId, confirm }) =>
      toolResult(async () => {
        if (!confirm) throw new Error('Set confirm: true to build this blueprint.');
        const raw: unknown = JSON.parse(specJson);
        return executeBlueprintBuild(
          raw,
          { parent: parentId, workspace: workspaceId, yes: true },
          await session(),
        );
      }),
  );

  server.registerTool(
    'list_notifications',
    {
      description: 'List one page of your own notifications, newest first, with the unread count.',
      inputSchema: {
        unreadOnly: z.boolean().default(false),
        cursor: z.string().max(512).optional(),
      },
    },
    ({ unreadOnly, cursor }) =>
      toolResult(async () =>
        executeListNotifications(await session(), { unread: unreadOnly, cursor }),
      ),
  );

  server.registerTool(
    'mark_notification_read',
    {
      description: 'Mark one of your notifications read.',
      inputSchema: { notificationId: identifier },
    },
    ({ notificationId }) =>
      toolResult(async () => executeReadNotification(await session(), notificationId)),
  );

  server.registerTool(
    'mark_all_notifications_read',
    { description: 'Mark all of your notifications read.', inputSchema: {} },
    () => toolResult(async () => executeReadAllNotifications(await session())),
  );

  server.registerTool(
    'get_notification_preferences',
    {
      description:
        'Read your time zone, quiet hours, due-reminder time, reminder switches and muted containers.',
      inputSchema: {},
    },
    () =>
      toolResult(async () =>
        (await session()).client.query(notifications.preferences(), { forceRefresh: true }),
      ),
  );

  server.registerTool(
    'set_notification_preferences',
    {
      description:
        'Change only the given preferences. quiet is "HH:mm-HH:mm" or "off"; mute and unmute take container item ids.',
      inputSchema: {
        timeZone: z.string().max(64).optional(),
        quiet: z.string().max(11).optional(),
        dueReminderTime: z.string().max(5).optional(),
        dueReminders: z.boolean().optional(),
        habitReminders: z.boolean().optional(),
        mute: z.array(identifier).max(200).optional(),
        unmute: z.array(identifier).max(200).optional(),
      },
    },
    (input) =>
      toolResult(async () => {
        const onOff = (value: boolean | undefined) =>
          value === undefined ? undefined : value ? 'on' : 'off';
        const changes = parsePreferenceFlags({
          timeZone: input.timeZone,
          quiet: input.quiet,
          dueTime: input.dueReminderTime,
          dueReminders: onOff(input.dueReminders),
          habitReminders: onOff(input.habitReminders),
          mute: input.mute,
          unmute: input.unmute,
        });
        return executeSetPreferences(await session(), changes);
      }),
  );

  server.registerTool(
    'set_reminder',
    {
      description:
        'Remind yourself about an item once. when: local "2026-10-01T09:00", instant "...Z", zoned "...+01:00[Europe/London]" or relative "+90m"/"+2h"/"+1d". zone defaults to your preference.',
      inputSchema: {
        itemId: identifier,
        when: z.string().min(1).max(80),
        zone: z.string().max(64).optional(),
      },
    },
    ({ itemId, when, zone }) =>
      toolResult(async () => executeSetReminder(await session(), itemId, when, { zone })),
  );

  server.registerTool(
    'clear_reminder',
    { description: "Remove an item's reminder.", inputSchema: { itemId: identifier } },
    ({ itemId }) => toolResult(async () => executeClearReminder(await session(), itemId)),
  );

  server.registerTool(
    'set_item_protection',
    {
      description:
        'Protect an item from deletion, stop it accepting new children, or switch its live ' +
        "collaboration (off means one editor at a time). 'on' or 'off' for each; an omitted one is " +
        "left as it is. A linked calendar's own protection cannot be switched off here.",
      inputSchema: {
        itemId: identifier,
        delete: z.enum(['on', 'off']).optional(),
        children: z.enum(['on', 'off']).optional(),
        collaboration: z.enum(['on', 'off']).optional(),
      },
    },
    ({ itemId, delete: deletion, children, collaboration }) =>
      toolResult(async () =>
        executeProtect(await session(), itemId, {
          ...(deletion === undefined ? {} : { delete: deletion }),
          ...(children === undefined ? {} : { children }),
          ...(collaboration === undefined ? {} : { collaboration }),
        }),
      ),
  );

  server.registerTool(
    'list_calendar_links',
    {
      description: 'List the Google and Outlook calendars linked into your workspaces.',
      inputSchema: {},
    },
    () => toolResult(async () => executeListLinks(await session())),
  );

  server.registerTool(
    'sync_calendar_link',
    {
      description: 'Ask for a sync round of a calendar link now.',
      inputSchema: { linkId: identifier },
    },
    ({ linkId }) => toolResult(async () => executeSyncLink(await session(), linkId)),
  );

  server.registerTool(
    'calendar_link_log',
    {
      description: "Read the newest entries of a calendar link's sync log.",
      inputSchema: { linkId: identifier },
    },
    ({ linkId }) => toolResult(async () => executeLinkLog(await session(), linkId)),
  );

  server.registerTool(
    'unlink_calendar',
    {
      description:
        "Unlink a calendar. Nothing is removed from the external calendar. 'keep' leaves the notes " +
        "it created as ordinary items; 'trash' moves them to the trash.",
      inputSchema: { linkId: identifier, items: z.enum(['keep', 'trash']) },
    },
    ({ linkId, items }) => toolResult(async () => executeUnlink(await session(), linkId, items)),
  );

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

  // Notes and items (requirement 9): the general read/write surface a remote client needs, through
  // the same Core and Collab paths the CLI's `item` and `note` commands use. Core authorizes each
  // call; a locked or invisible note is refused with Core's words, never read around.
  server.registerTool(
    'list_items',
    {
      description:
        'List the children of an item, or the roots of a workspace when no parent is given, up to `limit` (default 200); `truncated` says when there were more.',
      inputSchema: {
        workspaceId: identifier,
        parentId: identifier.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ workspaceId, parentId, limit }) =>
      toolResult(async () => {
        const current = await session();
        const ceiling = limit ?? 200;
        const rows: unknown[] = [];
        let truncated = false;
        for await (const item of current.client.paginate(
          items.listItems(workspaceId, {
            ...(parentId === undefined ? {} : { parentId }),
            pageSize: Math.min(ceiling, 100),
          }),
        )) {
          if (rows.length >= ceiling) {
            truncated = true;
            break;
          }
          rows.push(item);
        }
        return { items: rows, count: rows.length, truncated };
      }),
  );
  server.registerTool(
    'get_item',
    {
      description: 'Read one item: title, type, parent, properties and protections.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) => toolResult(async () => (await session()).client.query(items.itemById(itemId))),
  );
  server.registerTool(
    'create_item',
    {
      description:
        'Create an item (a note by default) under a parent, or at the workspace root. An empty title is kept as given.',
      inputSchema: {
        workspaceId: identifier,
        title: z.string().max(500),
        type: z.string().min(1).max(40).optional(),
        parentId: identifier.optional(),
      },
    },
    ({ workspaceId, title, type, parentId }) =>
      toolResult(async () =>
        (await session()).client.execute(
          items.createItem(workspaceId, {
            type: type ?? 'note',
            title,
            parentId: parentId ?? null,
          }),
        ),
      ),
  );
  server.registerTool(
    'search_items',
    {
      description: 'Full-text search over the items you may read.',
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    ({ query, limit }) =>
      toolResult(async () => (await session()).client.query(search.searchItems(query, limit))),
  );
  server.registerTool(
    'read_note',
    {
      description: 'Read a note body as Markdown, with the list of what Markdown could not carry.',
      inputSchema: { itemId: identifier },
    },
    ({ itemId }) =>
      toolResult(async () => {
        const current = await session();
        const token = await requireAccessToken(current);
        return readBodyMarkdown({ collabUrl: current.endpoints.collabUrl, itemId, token });
      }),
  );
  server.registerTool(
    'write_note',
    {
      description:
        'Replace a note body with Markdown (up to 200,000 characters). The Markdown must parse into a valid note.',
      inputSchema: { itemId: identifier, markdown: z.string().max(200_000) },
    },
    ({ itemId, markdown }) =>
      toolResult(async () => {
        const current = await session();
        const token = await requireAccessToken(current);
        return writeBodyMarkdown({
          collabUrl: current.endpoints.collabUrl,
          itemId,
          token,
          markdown,
        });
      }),
  );

  server.registerTool(
    'move_item',
    {
      description:
        'Move an item under a new parent (omit parentId for the workspace root), after a sibling if afterId is given. ' +
        'Pass destinationWorkspaceId to move it into another workspace.',
      inputSchema: {
        workspaceId: identifier,
        itemId: identifier,
        parentId: identifier.nullable().optional(),
        afterId: identifier.nullable().optional(),
        destinationWorkspaceId: identifier.optional(),
      },
    },
    ({ workspaceId, itemId, parentId, afterId, destinationWorkspaceId }) =>
      toolResult(async () =>
        (await session()).client.execute(
          items.moveItem(workspaceId, itemId, {
            parentId: parentId ?? null,
            afterId,
            workspaceId: destinationWorkspaceId,
          }),
        ),
      ),
  );
  server.registerTool(
    'rename_item',
    {
      description: "Change an item's title.",
      inputSchema: {
        workspaceId: identifier,
        itemId: identifier,
        title: z.string().min(1).max(500),
      },
    },
    ({ workspaceId, itemId, title }) =>
      toolResult(async () =>
        (await session()).client.execute(items.renameItem(workspaceId, itemId, title)),
      ),
  );
  server.registerTool(
    'trash_item',
    {
      description: 'Move an item to the trash. It can be restored with restore_item until purged.',
      inputSchema: { workspaceId: identifier, itemId: identifier },
    },
    ({ workspaceId, itemId }) =>
      toolResult(async () => {
        await (await session()).client.execute(items.deleteItem(workspaceId, itemId));
        return { id: itemId, deleted: true };
      }),
  );
  server.registerTool(
    'restore_item',
    {
      description: 'Restore an item from the trash.',
      inputSchema: { workspaceId: identifier, itemId: identifier },
    },
    ({ workspaceId, itemId }) =>
      toolResult(async () =>
        (await session()).client.execute(items.restoreItem(workspaceId, itemId)),
      ),
  );
  server.registerTool(
    'list_trash',
    {
      description: "List a workspace's trashed items.",
      inputSchema: { workspaceId: identifier, limit: z.number().int().min(1).max(200).optional() },
    },
    ({ workspaceId, limit }) =>
      toolResult(async () => {
        const ceiling = limit ?? 100;
        const rows: unknown[] = [];
        for await (const item of (await session()).client.paginate(
          items.listTrash(workspaceId, Math.min(ceiling, 100)),
        )) {
          rows.push(item);
          if (rows.length >= ceiling) break;
        }
        return { items: rows, count: rows.length };
      }),
  );
  server.registerTool(
    'set_item_properties',
    {
      description: 'Merge property values onto an item by key; a null value clears that key.',
      inputSchema: { itemId: identifier, properties: jsonObjectInput },
    },
    ({ itemId, properties }) =>
      toolResult(async () =>
        (await session()).client.execute(structure.setItemProperties(itemId, properties)),
      ),
  );

  // History lives in the collaboration service, so these reach it the way read_note does.
  const history = async (itemId: string) => {
    const current = await session();
    return {
      collabUrl: current.endpoints.collabUrl,
      itemId,
      token: await requireAccessToken(current),
    };
  };
  server.registerTool(
    'list_note_history',
    {
      description:
        "List a note's revisions, newest first (page back with before), and its named versions.",
      inputSchema: {
        itemId: identifier,
        limit: z.number().int().min(1).max(100).optional(),
        before: z.number().int().min(0).optional(),
      },
    },
    ({ itemId, limit, before }) =>
      toolResult(async () => {
        const target = await history(itemId);
        const [revisions, named] = await Promise.all([
          listRevisions({
            ...target,
            limit: limit ?? 50,
            ...(before === undefined ? {} : { before }),
          }),
          listNamedVersions(target),
        ]);
        return { revisions, namedVersions: named.versions };
      }),
  );
  server.registerTool(
    'restore_note_version',
    {
      description:
        'Replace the note with its state at a revision (seq), as one new revision; history is kept. ' +
        'Everyone sees the restored text, so confirm with the user first.',
      inputSchema: { itemId: identifier, seq: z.number().int().min(0), confirm: z.boolean() },
    },
    ({ itemId, seq, confirm }) =>
      toolResult(async () => {
        if (!confirm) throw new Error('Set confirm: true to restore this version.');
        return restoreRevision({ ...(await history(itemId)), seq });
      }),
  );
  server.registerTool(
    'name_note_version',
    {
      description: 'Name a revision (seq) so retention never removes it.',
      inputSchema: {
        itemId: identifier,
        seq: z.number().int().min(0),
        name: z.string().min(1).max(200),
      },
    },
    ({ itemId, seq, name }) =>
      toolResult(async () => nameVersion({ ...(await history(itemId)), seq, name })),
  );

  server.registerTool(
    'find_nix_action',
    {
      description:
        'Find Nix operations for anything the typed tools do not cover, by plain-language query. ' +
        'Returns each operation with its path, query and body shape; run one with run_nix_action. ' +
        'Operations that manage your credentials, pet settings, push subscriptions or calendar connections are not offered.',
      inputSchema: {
        query: z.string().min(1).max(300),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    ({ query, limit }) =>
      toolResult(() =>
        Promise.resolve({
          operations: findOperations(
            query,
            limit ?? 8,
            (entry) => !isHumanOnlyOperation(entry),
          ).map((entry) => ({
            operationId: entry.id,
            method: entry.method,
            path: entry.path,
            summary: entry.summary,
            detail: entry.detail,
            pathParams: entry.pathParams,
            queryParams: entry.queryParams,
            body: entry.body,
            risk: operationRisk(entry),
          })),
        }),
      ),
  );
  server.registerTool(
    'run_nix_action',
    {
      description:
        'Run one operation found with find_nix_action. Prefer a typed tool when one exists. Core still ' +
        'enforces your permissions, locks and access scopes. An operation with a risk (irreversible, ' +
        'access, public) changes things that are hard to undo or who can see them: confirm with the user, then pass confirm: true.',
      inputSchema: {
        operationId: z.string().min(1).max(100),
        path: z.record(z.string(), z.string()).optional(),
        query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        body: z.unknown().optional(),
        confirm: z.boolean().optional(),
      },
    },
    ({ operationId, path, query, body, confirm }) =>
      toolResult(async () => {
        const entry = operationById(operationId);
        if (entry === undefined) throw new Error(`There is no Nix operation '${operationId}'.`);
        if (isHumanOnlyOperation(entry))
          throw new Error(
            `${operationId} manages credentials, grants or approvals, or steers a chat; do this yourself in Nix.`,
          );
        const risk = operationRisk(entry);
        // Same rule as the typed member and invitation tools: risky changes need an explicit yes.
        if (risk !== undefined && confirm !== true)
          throw new Error(
            `${operationId} is ${risk === 'irreversible' ? 'irreversible' : risk === 'access' ? 'an access change' : 'a public change'}; confirm with the user, then call again with confirm: true.`,
          );
        const result = await callOperation((await session()).client, operationId, {
          path,
          query,
          body,
        });
        return risk === undefined ? { result } : { risk, result };
      }),
  );

  if (options.transport === 'http') {
    // Core permissions cannot authorize access to the MCP host's filesystem or saved profiles.
    for (const tool of [
      importDocument,
      uploadFile,
      replaceFile,
      downloadFile,
      previewTemplateArchiveImport,
      exportTemplateArchive,
    ]) {
      tool.remove();
    }
  }
  registerConversationMcpTools(server, session, toolResult);
  return server;
}

/** Runs `nixctl mcp` on stdio. Protocol messages are the only bytes written to stdout. */
export async function runWorkspaceMcpServer(profileName: string | undefined): Promise<void> {
  const server = await createWorkspaceMcpServer(profileName === undefined ? {} : { profileName });
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  await server.connect(new StdioServerTransport());
}

function lazy<T>(factory: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}
