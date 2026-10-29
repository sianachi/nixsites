import type { TemplatePreflight } from '@nix/api-client';
import {
  compileAddView,
  compileAddFields,
  compileEditFields,
  compileCreateStructured,
  compileEditForm,
  compileUpdateView,
  compileEntries,
  compileRecurrence,
  describeSteps,
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
  describeBlueprint,
  type Blueprint,
  type DescribeContext,
  type PreviewModel,
  type Step,
  type ValidationContext,
} from '@nix/structure-spec';
import type { Problem } from '@nix/structure-spec';
import type { PreviewContext } from './context.js';
import type { BodyEditPlan } from './ports.js';
export type { PreviewContext } from './context.js';
import { READ_ONLY_OPERATIONS, type WorkspaceToolArgs } from './tool-args.js';
import { planBuild } from './blueprint/plan.js';
import type { TaskCompletionPlan } from './tasks/complete-task.js';

/** `WorkspaceToolArgs` widened to the operations and `specJson` field added by task A.4. */
export type PreviewToolArgs = Omit<WorkspaceToolArgs, 'operation'> & {
  operation:
    | WorkspaceToolArgs['operation']
    | 'read_structure'
    | 'create_structured'
    | 'add_view'
    | 'create_entries'
    | 'add_fields'
    | 'edit_fields'
    | 'edit_form'
    | 'update_view'
    | 'set_recurrence';
  specJson: string;
};

type SpecOperation =
  | 'create_structured'
  | 'add_view'
  | 'create_entries'
  | 'add_fields'
  | 'edit_fields'
  | 'edit_form'
  | 'update_view'
  | 'set_recurrence';

/** The writes this executor never performs (architecture section 2.2's "never mapped to any operation" guard, restated for a person). Shown on every preview so approving one request never reads as approving more than the executor can do. */
const NEVER_DOES: readonly string[] = [
  'Publish a public link',
  'Delete anything permanently',
  'Remove a field',
  'Delete a view',
];

const READ_ONLY_PREVIEW_OPERATIONS: ReadonlySet<string> = new Set([
  ...READ_ONLY_OPERATIONS,
  'read_structure',
]);

function emptyCounts(): PreviewModel['counts'] {
  return { items: 0, fields: 0, views: 0, entries: 0, writes: 0 };
}

function compileSpecSteps(
  operation: SpecOperation,
  raw: unknown,
  args: PreviewToolArgs,
  context: PreviewContext,
): Step[] {
  switch (operation) {
    case 'create_structured': {
      const spec = structuredSpecSchema.parse(raw);
      return compileCreateStructured(spec, {
        parentId: args.parentId || null,
        title: args.title,
        inheritedFields: context.inheritedFields,
      });
    }
    case 'add_view': {
      const spec = viewSetupSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        effective: context.inheritedFields,
        views: [],
      };
      return compileAddView(spec, { itemId: args.itemId, existing });
    }
    case 'create_entries': {
      const spec = entriesSpecSchema.parse(raw);
      return compileEntries(spec, { parentId: args.parentId || null });
    }
    case 'edit_fields': {
      if (!context.existing) throw new Error('edit_fields preview context is missing.');
      return compileEditFields(fieldsSpecSchema.parse(raw), {
        itemId: args.itemId,
        existing: context.existing,
      });
    }
    case 'add_fields': {
      const spec = fieldsSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        inherit: true,
        effective: context.inheritedFields,
        views: [],
      };
      return compileAddFields(spec, { itemId: args.itemId, existing });
    }
    case 'update_view': {
      const spec = updateViewSpecSchema.parse(raw);
      if (!context.existing) throw new Error('update_view preview context is missing.');
      return compileUpdateView(spec, { itemId: args.itemId, existing: context.existing });
    }
    case 'edit_form': {
      const spec = formEditSpecSchema.parse(raw);
      const existing = context.existing ?? {
        declared: [],
        inherit: true,
        effective: context.inheritedFields,
        views: [],
      };
      const view = existing.views.find((candidate) => candidate.id === spec.viewId);
      if (view === undefined) throw new Error(`View "${spec.viewId}" does not exist on this item.`);
      return compileEditForm(spec, { itemId: args.itemId, existing, view });
    }
    case 'set_recurrence': {
      const spec = recurrenceSpecSchema.parse(raw);
      return compileRecurrence(spec, { itemId: args.itemId });
    }
  }
}

function describeSpecOperation(
  operation: SpecOperation,
  args: PreviewToolArgs,
  context: PreviewContext,
): PreviewModel {
  let raw: unknown;
  try {
    raw = JSON.parse(args.specJson);
  } catch {
    return {
      headline: 'I cannot run this request as written.',
      destination: context.destination,
      counts: emptyCounts(),
      tree: [],
      notes: [],
      warnings: [],
      problems: [
        { path: 'specJson', code: 'invalid_json', message: 'specJson is not valid JSON.' },
      ],
      neverDoes: NEVER_DOES.slice(),
    };
  }

  const validationContext: ValidationContext = {
    inheritedFields: [...context.inheritedFields],
    ...(context.existing
      ? {
          existing: {
            declared: [...context.existing.declared],
            inherit: context.existing.inherit,
            views: [...context.existing.views],
            ...(context.existing.defaultViewId === undefined
              ? {}
              : { defaultViewId: context.existing.defaultViewId }),
            ...(context.existing.hideDocument === undefined
              ? {}
              : { hideDocument: context.existing.hideDocument }),
          },
        }
      : {}),
    ...(context.itemValues !== undefined ? { itemValues: context.itemValues } : {}),
    // ValidationContext.today is reserved for a relative-date check `validateSpec` does not yet
    // perform for these three operations; there is no real clock port on `PreviewContext` to read
    // it from, so this is left blank rather than guessed.
    today: '',
  };
  const report = validateSpec(operation, raw, validationContext);
  const problems = [...context.problems, ...report.problems];
  const warnings = [...(context.warnings ?? []), ...report.warnings];
  if (!report.ok || problems.length > 0) {
    return {
      headline: 'I cannot run this request as written.',
      destination: context.destination,
      counts: { ...emptyCounts(), views: report.stats.views, entries: report.stats.entries },
      tree: [],
      notes: [],
      warnings,
      problems,
      neverDoes: NEVER_DOES.slice(),
    };
  }

  const steps = compileSpecSteps(operation, raw, args, context);
  const describeContext: DescribeContext = {
    destination: context.destination,
    ...(context.existing ? { existing: context.existing } : {}),
    problems,
    warnings,
    // Security fix S1: this model only ever backs an approval card, so note and entry body text
    // is never cut short here - the owner must see everything a write would store before deciding.
    truncate: false,
  };
  const model = describeSteps(steps, describeContext);
  return { ...model, neverDoes: NEVER_DOES.slice() };
}

function applyTemplateNotes(preflight: TemplatePreflight | undefined): string[] {
  if (preflight === undefined) return [];
  const notes = [
    `Adds ${String(preflight.additions.items)} items, ${String(preflight.additions.fields)} fields and ${String(preflight.additions.views)} views.`,
  ];
  if (preflight.conflicts.length > 0) {
    notes.push(`Conflicts: ${preflight.conflicts.join('; ')}.`);
  }
  return notes;
}

function applyTemplateProblems(preflight: TemplatePreflight | undefined): Problem[] {
  if (preflight === undefined || preflight.canApply) return [];
  return [
    {
      path: 'template',
      code: 'conflict',
      message: `This template cannot be applied here: ${preflight.conflicts.join('; ')}.`,
    },
  ];
}

/** Sentences kept byte-for-byte from `packages/web-pets/src/pets/work-tools/pet-work-tools.tsx`'s
 * `describeWorkspaceAction` (lines 226-255), with `read_structure` using the architecture's
 * structure-aware description. `list_templates` and `read_template` use this task card's copy. */
function legacyHeadline(args: PreviewToolArgs): string {
  switch (args.operation) {
    case 'list_items':
      return args.parentId
        ? 'I will list the items inside the linked destination to find what to work on.'
        : 'I will list the top-level items in this workspace to find what to work on.';
    case 'search':
      return `I will search this workspace for “${args.query}” to find matching items.`;
    case 'read_item':
      return 'I will read the linked item’s details and properties.';
    case 'read_note':
      return 'I will read the linked note’s content for context.';
    case 'search_note':
      return `I will search the linked note and the notes under it for “${args.query}”.`;
    case 'read_view':
      return 'I will read a bounded sample and counts from the linked view, with its display limits.';
    case 'read_structure':
      return "I will read the linked item's fields, views and how many children it has.";
    case 'create_note':
      return `I will create a note named “${args.title}” ${args.parentId ? 'inside the linked destination' : 'at the top level of this workspace'}${args.markdown ? ', with the content shown below' : ', with an empty body'}.`;
    case 'append_note':
      return 'I will add the content below to the end of the linked note, preserving its existing content.';
    case 'replace_section':
      return `I will rewrite the section “${sectionName(args.query)}” in the linked note. The rest of the note stays as it is.`;
    case 'replace_passage':
      return 'I will change one passage in the linked note. The rest of the note stays as it is.';
    case 'rename_item':
      return `I will rename the linked item to “${args.title}”.`;
    case 'move_item':
      return `I will move the linked item ${args.parentId ? 'inside the linked destination' : 'to the top level of this workspace'}.`;
    case 'set_properties':
      return 'I will update the linked item with the property values shown below, leaving other properties unchanged.';
    case 'trash_item':
      return 'I will move the linked item to Trash. It can be restored later.';
    case 'restore_item':
      return 'I will restore the linked item from Trash.';
    case 'list_templates':
      return 'I will list the templates this workspace can apply.';
    case 'read_template':
      return 'I will read the outline of the linked template.';
    case 'apply_template':
      return `I will create “${args.title}” from the linked template${args.parentId ? ' inside the linked destination' : ' at the top level of this workspace'}.`;
    case 'read_calendar':
      return 'I will read what is on this workspace’s calendars for the dates asked.';
    case 'complete_task':
      return 'I will change whether the linked task is done.';
    case 'create_structured':
    case 'add_view':
    case 'create_entries':
    case 'edit_fields':
    case 'add_fields':
    case 'edit_form':
    case 'update_view':
    case 'set_recurrence':
    case 'build_blueprint':
    case 'save_as_template':
      throw new Error(`${args.operation} is a spec operation and has no legacy headline.`);
  }
}

/** A `complete_task` card says which task, what it becomes, and - for a repeating task - which
 * occurrence, so approving it never reads as "tick something". */
function taskCompletionCopy(plan: TaskCompletionPlan): { headline: string; notes: string[] } {
  if (plan.kind === 'occurrence')
    return {
      headline: `I will mark the ${plan.occurredOn} occurrence of the repeating task “${plan.title}” done.`,
      notes: ['The task keeps repeating; its next occurrence stays open.'],
    };
  const state = plan.completed ? 'done' : 'not done';
  return {
    headline: `I will mark “${plan.title}” ${state}.`,
    notes: plan.unchanged ? [`It is already ${state}, so nothing will change.`] : [],
  };
}

function describeLegacyOperation(args: PreviewToolArgs, context: PreviewContext): PreviewModel {
  if (args.operation === 'complete_task' && context.taskCompletion !== undefined) {
    const copy = taskCompletionCopy(context.taskCompletion);
    return {
      headline: copy.headline,
      destination: context.destination,
      counts: {
        ...emptyCounts(),
        writes:
          context.taskCompletion.kind === 'property' && context.taskCompletion.unchanged ? 0 : 1,
      },
      tree: [],
      notes: copy.notes,
      warnings: [],
      problems: context.problems,
      neverDoes: NEVER_DOES.slice(),
    };
  }
  const notes = args.operation === 'apply_template' ? applyTemplateNotes(context.preflight) : [];
  const templateProblems =
    args.operation === 'apply_template' ? applyTemplateProblems(context.preflight) : [];
  return {
    headline: legacyHeadline(args),
    destination: context.destination,
    counts: {
      ...emptyCounts(),
      writes: READ_ONLY_PREVIEW_OPERATIONS.has(args.operation) ? 0 : 1,
    },
    tree: [],
    notes,
    warnings: context.warnings ?? [],
    problems: [...context.problems, ...templateProblems],
    neverDoes: NEVER_DOES.slice(),
  };
}

/**
 * Describes one pending `nix_workspace` tool call as a `PreviewModel` (architecture section 7),
 * so the approval card (task A.6) and `nixctl pet tools run` (task 0.5, updated by A.6/A.7) render
 * exactly what will happen with no JSX and no raw JSON. A spec operation is validated and compiled
 * before it is described, so a request `validateSpec` refuses never reaches `describeSteps` - its
 * problems are surfaced directly instead.
 */
export function describeToolCall(args: PreviewToolArgs, context: PreviewContext): PreviewModel {
  if (args.operation === 'save_as_template') {
    const spec = (args.specJson.trim() ? JSON.parse(args.specJson) : {}) as {
      includeSamples?: boolean;
      inputs?: { label: string }[];
    };
    const sourceTitle = context.sourceTitle ?? 'the linked item';
    const sampleNote =
      (spec.includeSamples ?? false)
        ? 'Example entries are included.'
        : `${String(context.sampleCount ?? 0)} example entries are left out.`;
    const inputLabels = (spec.inputs ?? []).map((input) => input.label);
    return {
      headline: `I will save “${sourceTitle}” and ${String(Math.max(0, (context.sourceItemCount ?? 1) - 1))} children as the template “${args.title}”. Bodies are included. ${sampleNote}`,
      destination: context.destination,
      counts: { ...emptyCounts(), items: context.sourceItemCount ?? 1, writes: 1 },
      tree: [],
      notes: [
        ...(inputLabels.length ? [`It will ask for: ${inputLabels.join(', ')}.`] : []),
        'Anyone who can see this workspace’s templates can apply it.',
      ],
      warnings: [],
      problems: [],
      neverDoes: NEVER_DOES.slice(),
    };
  }
  if (args.operation === 'build_blueprint') {
    // Validate the raw spec before parsing it, so a wrong shape becomes listed problems the pet
    // can fix rather than a preview that fails to load.
    const raw: unknown = JSON.parse(args.specJson);
    const report =
      context.blueprintReport ??
      validateBlueprint(raw, { inheritedFields: context.inheritedFields, today: '' });
    if (!report.ok)
      return {
        headline: 'I cannot run this request as written.',
        destination: context.destination,
        counts: {
          ...emptyCounts(),
          fields: report.stats.fields,
          views: report.stats.views,
          entries: report.stats.entries,
        },
        tree: [],
        notes: [],
        warnings: report.warnings,
        problems: report.problems,
        neverDoes: NEVER_DOES.slice(),
      };
    const blueprint = blueprintSchema.parse(raw);
    const plan = planBlueprintPreview(blueprint, args.parentId, context);
    const model = describeBlueprint(blueprint, report, { destination: context.destination });
    return {
      ...model,
      counts: { ...model.counts, writes: plan.writes },
      neverDoes: NEVER_DOES.slice(),
    };
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
      return describeSpecOperation(args.operation, args, context);
    case 'replace_section':
    case 'replace_passage':
      return describeBodyEdit(args, context);
    default:
      return describeLegacyOperation(args, context);
  }
}

/** The owner-facing sentence for each formatting loss a body edit causes, in the future tense:
 * the converter's own detail is a past-tense log line about an export. A comment mark is only a
 * highlight: Nix keeps no comment threads outside the note, so removing the mark loses nothing
 * else. */
const BODY_EDIT_LOSSES: Readonly<Record<string, string>> = {
  'alignment-dropped': 'Its text alignment goes back to the default.',
  'color-dropped': 'Its text colour is removed. The words stay.',
  'highlight-dropped': 'Its highlights are removed. The words stay.',
  'underline-dropped': 'Its underlines are removed. The words stay.',
  'comment-dropped': 'Its comment highlights are removed. The words stay.',
  'task-list-flattened': 'Its checklist becomes a plain bullet list, and ticks are lost.',
  'columns-flattened': 'Its side-by-side columns become one column.',
  'table-flattened': 'Its table loses merged cells, column widths and cell formatting.',
};
const BODY_EDIT_LOSS_FALLBACK = 'Some of its formatting is removed. The words stay.';

/** A section heading as the owner reads it: without the `#` marks the model may have sent. */
function sectionName(heading: string): string {
  return quotable(heading.replace(/^\s*#{1,6}\s+/, ''));
}

/** Quoted note text, cut to about 40 characters so a headline or region name stays readable. */
function quotable(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39).trimEnd()}…` : flat;
}

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function bodyEditHeadline(args: PreviewToolArgs, plan: BodyEditPlan): string {
  if (plan.scope === 'section')
    return `I will rewrite the section “${sectionName(args.query)}” in the linked note. The rest of the note stays as it is.`;
  const block = plan.after
    ? `The ${plan.scope} it sits in is rewritten`
    : `The ${plan.scope} it sits in is removed`;
  return args.markdown
    ? `I will change one passage in the linked note. ${block}; the rest of the note stays as it is.`
    : `I will remove one passage from the linked note. ${block}; the rest of the note stays as it is.`;
}

/** A section or passage edit: what it changes, the before and after text, and anything the
 * replaced blocks carry that Markdown cannot keep, so the owner sees a loss before approving. */
function describeBodyEdit(args: PreviewToolArgs, context: PreviewContext): PreviewModel {
  const model = describeLegacyOperation(args, context);
  const plan = context.bodyEdit;
  if (plan === undefined) return model;
  const where = plan.scope === 'section' ? 'This section' : `This ${plan.scope}`;
  const subject =
    plan.scope === 'section'
      ? `Section “${sectionName(args.query)}” in ${context.destination.title}`
      : `${capitalized(plan.scope)} with “${quotable(args.query)}” in ${context.destination.title}`;
  return {
    ...model,
    headline: bodyEditHeadline(args, plan),
    warnings: [
      ...model.warnings,
      ...plan.losses.map((loss) => ({
        path: where,
        code: loss.kind,
        message: BODY_EDIT_LOSSES[loss.kind] ?? BODY_EDIT_LOSS_FALLBACK,
      })),
    ],
    bodyEdit: {
      scope: plan.scope,
      subject,
      ...(plan.beforeRange ? { beforeRange: plan.beforeRange } : {}),
      ...(plan.afterRange ? { afterRange: plan.afterRange } : {}),
      before: plan.before,
      after: plan.after,
      blocksRemoved: plan.blocksRemoved,
      blocksAdded: plan.blocksAdded,
      losesFormatting: plan.losses.length > 0,
    },
  };
}

export function planBlueprintPreview(
  blueprint: Blueprint,
  parentId: string,
  context: PreviewContext,
): ReturnType<typeof planBuild> {
  return planBuild(blueprint, {
    parentId: parentId || null,
    sandboxExists: context.sandboxExists ?? false,
    clock: { today: () => '', timeZone: () => 'UTC', now: () => new Date(0) },
    inheritedFields: context.inheritedFields,
  });
}
