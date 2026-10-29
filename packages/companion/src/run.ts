import * as editFields from './structure/edit-fields.js';
import { z } from 'zod';
import { items, NixApiError, pets, search, structure } from '@nix/api-client';
import {
  applySpecSchema,
  entriesSpecSchema,
  fieldsSpecSchema,
  formEditSpecSchema,
  recurrenceSpecSchema,
  structuredSpecSchema,
  validateSpec,
  viewSetupSpecSchema,
  updateViewSpecSchema,
  blueprintSchema,
  validateBlueprint,
  saveSpecSchema,
} from '@nix/structure-spec';
import type { CompanionPorts } from './ports.js';
import { applyTemplate } from './templates/apply.js';
import { listTemplates } from './templates/list.js';
import { readTemplate } from './templates/read.js';
import { bodyEditOf, loadPreviewContext } from './context.js';
import { checkItem, hasProseBody, type StructureFingerprint } from './guards.js';
import { readStructure } from './structure/read-structure.js';
import { readView } from './structure/read-view.js';
import { boundedStructureRead } from './structure/read-output.js';
import * as updateView from './structure/update-view.js';
import * as createStructured from './structure/create-structured.js';
import * as addView from './structure/add-view.js';
import * as createEntries from './structure/create-entries.js';
import * as addFields from './structure/add-fields.js';
import * as editForm from './structure/edit-form.js';
import * as setRecurrence from './structure/recurrence.js';
import { READ_ONLY_OPERATIONS, WorkspaceToolRefusal, workspaceToolSchema } from './tool-args.js';
import { planBuild } from './blueprint/plan.js';
import { executeBuild } from './blueprint/build.js';
import { saveAsTemplate } from './templates/save.js';
import { listedItems } from './read/list-items.js';
import { anyUnderLock } from './read/locks.js';
import { calendarRange, readCalendar } from './read/calendar.js';
import {
  prepareNoteScopedTool,
  checkNoteScopedItem,
  listNoteScopedItems,
  searchNoteScopedItems,
  type NoteToolScope,
} from './scope.js';
import {
  completedFlag,
  completeTask,
  planTaskCompletion,
  taskCompletionFingerprint,
} from './tasks/complete-task.js';

export { WorkspaceToolRefusal } from './tool-args.js';

export interface RunOptions {
  toolId?: string;
  claimId?: string;
  buildLedger?: readonly { nodeId: string; itemId?: string; status?: string }[];
  fence?: StructureFingerprint;
  onProgress?: (completed: number, total: number) => void;
  scope?: NoteToolScope;
}

export interface WorkspaceToolOutcome {
  text: string;
  readOnly: boolean;
  touchedParents: (string | null)[];
  /** Whether this read returned anything from an item under a lock (its own or an ancestor's).
   * The web gate holds every later write in the same turn for the owner when it is true; writes
   * always report false. */
  lockedContent: boolean;
  /** A file read's picture, as a `data:image/...;base64` URL, sent beside `text`. */
  image?: string;
}

/** The most memories the owner's settings hold; Core refuses more. */
const MAX_MEMORIES = 50;

/** Adds one fact to the owner's pet memory, the list Settings > Pets > Memory shows and edits.
 * The settings document is saved at the revision just read, once more if another save won. */
async function remember(
  client: CompanionPorts['core'],
  fact: string,
  options: { signal: AbortSignal },
): Promise<{ remembered: string; alreadyKnown?: true }> {
  const text = fact.trim().replace(/\s+/g, ' ');
  if (text.length > 280)
    throw new WorkspaceToolRefusal('A memory is one short sentence of at most 280 characters.');
  for (let attempt = 0; ; attempt += 1) {
    const { revision, settings } = await client.query(pets.settings(), options);
    if (settings.memoryOff)
      throw new WorkspaceToolRefusal(
        'The owner has turned memory off in Settings > Pets. Nothing was saved.',
      );
    const known = settings.memories ?? [];
    if (known.some((memory) => memory.text.toLowerCase() === text.toLowerCase()))
      return { remembered: text, alreadyKnown: true };
    if (known.length >= MAX_MEMORIES)
      throw new WorkspaceToolRefusal(
        `Memory is full (${String(MAX_MEMORIES)} facts). Ask the owner to remove some in Settings > Pets > Memory.`,
      );
    const memories = [
      ...known,
      { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() },
    ];
    try {
      await client.execute(pets.saveSettings(revision, { ...settings, memories }), options);
      return { remembered: text };
    } catch (error) {
      if (attempt > 0 || !(error instanceof NixApiError) || error.status !== 409) throw error;
    }
  }
}

/** Execute only after the caller claims and approves this exact tool request. */
export async function runWorkspaceTool(
  ports: CompanionPorts,
  workspaceId: string,
  raw: string,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<WorkspaceToolOutcome> {
  const client = ports.core;
  const bodies = ports.bodies;
  if (raw.length > 40000) throw new Error('Tool arguments are too large.');
  const parsed = workspaceToolSchema.parse(JSON.parse(raw));
  const args = options.scope
    ? await prepareNoteScopedTool(ports, workspaceId, parsed, signal, options.scope)
    : parsed;

  const requestOptions = { signal, forceRefresh: true };
  let result: unknown;
  // The items a read returned content from, checked for a covering lock once the read is done.
  let unboundedReadProvenance = false;
  let contentSources: (string | null | undefined)[] = [];
  let image: string | undefined;
  const check = (id: string) =>
    options.scope
      ? checkNoteScopedItem(ports, workspaceId, id, signal, options.scope)
      : checkItem(ports, workspaceId, id, signal);
  const rawSpec: unknown = args.specJson.trim() ? JSON.parse(args.specJson) : {};
  if (args.operation === 'build_blueprint') {
    const context = await loadPreviewContext(ports, workspaceId, args, signal, options.scope);
    if (options.fence === undefined || context.fingerprint !== options.fence)
      throw new WorkspaceToolRefusal(
        'The destination changed since you approved this. Review the design again before building.',
      );
    // Validate the raw spec before parsing it: validateBlueprint reports a wrong shape as
    // problems the model can fix, where blueprintSchema.parse would only throw.
    const report =
      context.blueprintReport ??
      validateBlueprint(rawSpec, {
        inheritedFields: context.inheritedFields,
        today: ports.clock.today(),
      });
    if (!report.ok)
      throw new WorkspaceToolRefusal(
        report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
      );
    const blueprint = blueprintSchema.parse(rawSpec);
    const plan = planBuild(blueprint, {
      parentId: args.parentId || null,
      sandboxExists: context.sandboxExists ?? false,
      clock: ports.clock,
      inheritedFields: context.inheritedFields,
    });
    const result = await executeBuild(ports, workspaceId, plan, signal, options.onProgress);
    return {
      text: JSON.stringify(result),
      readOnly: false,
      touchedParents: [args.parentId || null],
      lockedContent: false,
    };
  }
  // Scope guards supplement, never replace, permission checks in Core and collab. Check every
  // named item identity before loading schema, views, paths, template preflight, or bodies.
  if (
    args.operation !== 'apply_template' &&
    args.operation !== 'read_template' &&
    args.operation !== 'save_as_template' &&
    args.operation !== 'restore_item' &&
    ![
      'list_items',
      'search',
      'create_note',
      'create_structured',
      'create_entries',
      'add_fields',
      'edit_fields',
      'edit_form',
      'update_view',
      'list_templates',
      'read_calendar',
      'remember',
    ].includes(args.operation)
  ) {
    await check(args.itemId);
  }
  if (args.parentId) await check(args.parentId);
  let templatePreflight;
  if (args.operation === 'apply_template') {
    applySpecSchema.parse(rawSpec);
    const context = await loadPreviewContext(ports, workspaceId, args, signal, options.scope);
    templatePreflight = context.preflight;
  }
  if (
    [
      'create_structured',
      'add_view',
      'create_entries',
      'add_fields',
      'edit_fields',
      'edit_form',
      'update_view',
      'set_recurrence',
    ].includes(args.operation)
  ) {
    const context = await loadPreviewContext(ports, workspaceId, args, signal, options.scope);
    if (options.fence === undefined || context.fingerprint !== options.fence)
      throw new WorkspaceToolRefusal(
        'The item changed since you approved this. Ask the pet to look again.',
      );
    if (context.problems.length > 0)
      throw new WorkspaceToolRefusal(context.problems.map((problem) => problem.message).join('\n'));
    if (args.operation === 'create_structured') {
      const spec = structuredSpecSchema.parse(rawSpec);
      const report = validateSpec('create_structured', spec, {
        inheritedFields: context.inheritedFields,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
        );
      result = await createStructured.execute(
        ports,
        workspaceId,
        createStructured.compile(spec, {
          parentId: args.parentId || null,
          title: args.title,
          inheritedFields: context.inheritedFields,
        }),
        signal,
      );
    } else if (args.operation === 'add_view') {
      const spec = viewSetupSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('add_view preview context is missing.');
      const report = validateSpec('add_view', spec, {
        inheritedFields: context.inheritedFields,
        existing,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((problem) => `${problem.path}: ${problem.message}`).join('\n'),
        );
      const steps = addView.compile(spec, {
        itemId: args.itemId,
        existing: {
          declared: existing.declared,
          effective: existing.effective,
          views: existing.views,
        },
      });
      result = await addView.execute(ports, steps, signal);
    } else if (args.operation === 'create_entries') {
      const spec = entriesSpecSchema.parse(rawSpec);
      result = await createEntries.execute(
        ports,
        workspaceId,
        args.parentId,
        spec,
        context.inheritedFields,
        signal,
      );
    } else if (args.operation === 'edit_fields') {
      const spec = fieldsSpecSchema.parse(rawSpec);
      if (!context.existing) throw new Error('edit_fields preview context is missing.');
      const report = validateSpec('edit_fields', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((problem) => problem.message).join('\n'),
        );
      result = await editFields.execute(
        ports,
        editFields.compile(spec, { itemId: args.itemId, existing: context.existing }),
        signal,
      );
    } else if (args.operation === 'add_fields') {
      const spec = fieldsSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('add_fields preview context is missing.');
      const report = validateSpec('add_fields', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      result = await addFields.execute(
        ports,
        addFields.compile(spec, { itemId: args.itemId, existing }),
        signal,
      );
    } else if (args.operation === 'update_view') {
      const spec = updateViewSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('update_view preview context is missing.');
      const report = validateSpec('update_view', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      result = await updateView.execute(
        ports,
        updateView.compile(spec, { itemId: args.itemId, existing }),
        signal,
      );
    } else if (args.operation === 'edit_form') {
      const spec = formEditSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('edit_form preview context is missing.');
      const report = validateSpec('edit_form', spec, { ...context, today: ports.clock.today() });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      const view = existing.views.find((candidate) => candidate.id === spec.viewId);
      if (view === undefined) throw new WorkspaceToolRefusal('The form view no longer exists.');
      result = await editForm.execute(
        ports,
        editForm.compile(spec, { itemId: args.itemId, existing, view }),
        signal,
      );
    } else {
      const spec = recurrenceSpecSchema.parse(rawSpec);
      const existing = context.existing;
      if (existing === undefined) throw new Error('set_recurrence preview context is missing.');
      const report = validateSpec('set_recurrence', spec, {
        ...context,
        today: ports.clock.today(),
      });
      if (!report.ok)
        throw new WorkspaceToolRefusal(
          report.problems.map((p) => `${p.path}: ${p.message}`).join('\n'),
        );
      result = await setRecurrence.execute(ports, setRecurrence.compile(spec, args.itemId), signal);
    }
  }
  switch (args.operation) {
    case 'create_structured':
    case 'add_view':
    case 'create_entries':
    case 'edit_fields':
    case 'add_fields':
    case 'edit_form':
    case 'update_view':
    case 'set_recurrence':
      break;
    case 'restore_item': {
      // Ordinary item reads intentionally hide deleted rows. Establish the exact
      // target through Core's workspace-scoped trash query before restoring it.
      let found = false;
      let checked = 0;
      for await (const item of client.paginate(items.listTrash(workspaceId, 50), requestOptions)) {
        if (++checked > 500) break;
        if (item.id === args.itemId && item.workspaceId === workspaceId) {
          found = true;
          break;
        }
      }
      if (!found)
        throw new WorkspaceToolRefusal(
          'The item was not found in this workspace’s first 500 trash entries. No restore was attempted.',
        );
      result = await client.execute(items.restoreItem(workspaceId, args.itemId), requestOptions);
      break;
    }
    case 'list_items': {
      if (options.scope) {
        const scoped = await listNoteScopedItems(
          ports,
          workspaceId,
          args.parentId,
          signal,
          options.scope,
        );
        result = scoped.result;
        contentSources = [args.parentId, ...scoped.contentSources];
        break;
      }
      const children = [];
      let truncated = false;
      for await (const item of client.paginate(
        items.listItems(workspaceId, { parentId: args.parentId || undefined, pageSize: 50 }),
        requestOptions,
      )) {
        if (children.length >= 50) {
          truncated = true;
          break;
        }
        children.push(item);
      }
      // Values are keyed by the container's effective schema; the workspace root has none, so
      // its rows carry identity only.
      const fields = args.parentId
        ? (await client.query(structure.effectiveSchema(args.parentId), requestOptions)).properties
        : [];
      result = listedItems(children, fields, truncated);
      contentSources = [args.parentId];
      break;
    }
    case 'remember': {
      result = await remember(client, args.markdown, requestOptions);
      break;
    }
    case 'read_calendar': {
      const calendar = await readCalendar(ports, workspaceId, calendarRange(args.specJson), signal);
      result = calendar.read;
      contentSources = calendar.containerIds;
      break;
    }
    case 'complete_task': {
      const plan = await planTaskCompletion(
        ports,
        workspaceId,
        args.itemId,
        completedFlag(args.specJson),
        signal,
      );
      if (options.fence === undefined || taskCompletionFingerprint(plan) !== options.fence)
        throw new WorkspaceToolRefusal(
          'The task changed since you approved this. Ask the pet to look again.',
        );
      result = await completeTask(ports, plan, signal);
      break;
    }
    case 'search': {
      if (options.scope) {
        const scoped = await searchNoteScopedItems(
          ports,
          workspaceId,
          args.query,
          signal,
          options.scope,
        );
        result = scoped.result;
        contentSources = scoped.contentSources;
        break;
      }
      if (!args.query.trim()) throw new Error('A search query is required.');
      if (z.uuid().safeParse(args.query.trim()).success) {
        const item = await check(args.query.trim());
        contentSources = [item.parentId];
        result = {
          results: [
            { id: item.id, workspaceId: item.workspaceId, title: item.title, type: item.type },
          ],
          truncated: false,
        };
        break;
      }
      // Items match a title or the words; passages also match by meaning, so a note that says
      // "holiday" answers a question about a trip.
      const [found, passages] = await Promise.all([
        client.query(search.searchItems(args.query, 50), requestOptions),
        client.query(search.workspacePassages(args.query, workspaceId, 8), requestOptions),
      ]);
      const hits = found.results.filter((item) => item.workspaceId === workspaceId);
      contentSources = [
        ...hits.map((hit) => hit.parentId),
        ...passages.passages.map((passage) => passage.itemId),
      ];
      result = { results: hits, truncated: found.truncated, passages: passages.passages };
      break;
    }
    case 'create_note': {
      if (!args.title.trim()) throw new Error('A title is required.');
      const item = await client.execute(
        items.createItem(workspaceId, {
          type: 'note',
          title: args.title,
          parentId: args.parentId || null,
        }),
        requestOptions,
      );
      if (args.markdown) {
        try {
          await bodies.append(item.id, args.markdown, signal);
        } catch {
          return {
            text: JSON.stringify({
              id: item.id,
              created: true,
              contentConfirmed: false,
              instruction:
                'Note created but content was not confirmed. Read this note before retrying. Do not create another note.',
            }),
            readOnly: false,
            touchedParents: [args.parentId || null],
            lockedContent: false,
          };
        }
      }
      result = { id: item.id, title: item.title, created: true, contentConfirmed: true };
      break;
    }
    case 'list_templates': {
      result = await listTemplates(ports, workspaceId, args.query, signal);
      break;
    }
    case 'read_template': {
      result = await readTemplate(ports, workspaceId, args.itemId, signal);
      break;
    }
    case 'apply_template': {
      const spec = applySpecSchema.parse(rawSpec);
      result = await applyTemplate(
        ports,
        workspaceId,
        {
          templateId: args.itemId,
          parentId: args.parentId || null,
          title: args.title,
          ...(spec.inputs ? { inputs: spec.inputs } : {}),
        },
        { toolId: options.toolId, claimId: options.claimId },
        signal,
        templatePreflight,
      );
      break;
    }
    case 'save_as_template': {
      const spec = saveSpecSchema.parse(rawSpec);
      const context = await loadPreviewContext(ports, workspaceId, args, signal, options.scope);
      if (
        options.fence === undefined ||
        context.fingerprint !== options.fence ||
        context.captureFingerprint === undefined
      )
        throw new WorkspaceToolRefusal(
          'The source changed since you approved this. Review it again before saving.',
        );
      result = await saveAsTemplate(
        ports,
        workspaceId,
        { itemId: args.itemId, title: args.title, spec },
        {
          toolId: options.toolId,
          claimId: options.claimId,
          approvedFingerprint: options.fence,
          captureFingerprint: context.captureFingerprint,
          buildLedger: options.buildLedger,
        },
        signal,
      );
      break;
    }
    default: {
      const item = await check(args.itemId);
      switch (args.operation) {
        case 'read_item':
          result = item;
          contentSources = [item.id];
          break;
        case 'read_structure':
          result = await readStructure(ports, workspaceId, item.id, signal);
          contentSources = [item.id];
          break;
        case 'read_view': {
          const evidence = await readView(ports, workspaceId, item.id, args.query, signal);
          result = evidence;
          contentSources = [
            item.id,
            ...evidence.results.flatMap((row) => [row.id, row.containerId]),
          ];
          // Aggregate matches have no bounded lock provenance; hold later writes conservatively.
          unboundedReadProvenance = evidence.hasUnboundedProvenance;
          break;
        }
        case 'search_note': {
          // Any root: a collection or folder has no body of its own but notes beneath it.
          const found = await client.query(
            search.notePassages(item.id, args.query, 8),
            requestOptions,
          );
          result = { id: item.id, title: item.title, passages: found.passages };
          contentSources = [item.id, ...found.passages.map((passage) => passage.itemId)];
          break;
        }
        case 'read_note':
        case 'append_note':
          if (args.operation === 'read_note' && item.type === 'file') {
            if (!ports.files)
              throw new WorkspaceToolRefusal(
                'Files cannot be read here. Ask the owner to open it.',
              );
            const { image: picture, ...read } = await ports.files.read(item.id, signal);
            result = { id: item.id, title: item.title, type: item.type, ...read };
            image = picture;
            contentSources = [item.id];
            break;
          }
          if (!hasProseBody(item.type))
            throw new Error('This operation supports note bodies only.');
          result =
            args.operation === 'read_note'
              ? await bodies.read(item.id, signal)
              : await bodies.append(item.id, args.markdown, signal);
          if (args.operation === 'read_note') contentSources = [item.id];
          break;
        case 'replace_section':
        case 'replace_passage': {
          if (!hasProseBody(item.type))
            throw new WorkspaceToolRefusal(
              'Only a note body can be edited. No change was made.',
              'Only a note’s text can be edited this way, so nothing was edited.',
            );
          const edit = bodyEditOf(args);
          if (edit === undefined) throw new Error('A body edit is required.');
          if (!options.fence)
            throw new WorkspaceToolRefusal(
              'This edit has no approved preview. Review it again before editing.',
              'This edit had no approved preview, so nothing was edited.',
            );
          try {
            result = await bodies.applyEdit(item.id, edit, options.fence, signal);
          } catch (reason) {
            // A refusal can quote the note (the headings it has, how often a passage appears);
            // a successful edit returns counts only, so only a refusal needs the lock check.
            if (reason instanceof WorkspaceToolRefusal)
              reason.lockedContent = await anyUnderLock(ports, [item.id], signal);
            throw reason;
          }
          break;
        }
        case 'rename_item':
          if (!args.title.trim()) throw new Error('A title is required.');
          result = await client.execute(
            items.renameItem(workspaceId, item.id, args.title),
            requestOptions,
          );
          break;
        case 'move_item':
          result = await client.execute(
            items.moveItem(workspaceId, item.id, { parentId: args.parentId || null }),
            requestOptions,
          );
          break;
        case 'set_properties': {
          const properties = z
            .record(z.string().max(160), z.unknown())
            .parse(JSON.parse(args.propertiesJson));
          result = await client.execute(
            structure.setItemProperties(item.id, properties),
            requestOptions,
          );
          break;
        }
        case 'trash_item':
          await client.execute(items.deleteItem(workspaceId, item.id), requestOptions);
          result = { id: item.id, trashed: true };
          break;
      }
    }
  }
  const text =
    args.operation === 'read_structure' || args.operation === 'read_view'
      ? boundedStructureRead(args.operation, result)
      : JSON.stringify(result);
  const readOnly = READ_ONLY_OPERATIONS.has(args.operation);
  const lockedContent =
    readOnly && (unboundedReadProvenance || (await anyUnderLock(ports, contentSources, signal)));
  return {
    lockedContent,
    text:
      text.length <= 16000
        ? text
        : JSON.stringify({ truncated: true, preview: text.slice(0, 15000) }),
    ...(image === undefined ? {} : { image }),
    readOnly,
    touchedParents: [
      'create_note',
      'move_item',
      'apply_template',
      'save_as_template',
      'create_structured',
      'create_entries',
    ].includes(args.operation)
      ? [args.parentId || null]
      : [
            'add_view',
            'update_view',
            'add_fields',
            'edit_fields',
            'edit_form',
            'set_recurrence',
          ].includes(args.operation)
        ? [args.itemId]
        : [],
  };
}
