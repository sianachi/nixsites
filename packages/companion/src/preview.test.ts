import { describe, expect, it } from 'vitest';
import { parseActionRun } from './action.js';
import {
  describeToolCall,
  planBlueprintPreview,
  type PreviewContext,
  type PreviewToolArgs,
} from './preview.js';

function args(overrides: Partial<PreviewToolArgs>): PreviewToolArgs {
  return {
    operation: 'list_items',
    itemId: '',
    parentId: '',
    title: '',
    markdown: '',
    query: '',
    propertiesJson: '',
    specJson: '',
    ...overrides,
  };
}

function context(overrides: Partial<PreviewContext> = {}): PreviewContext {
  return {
    destination: { title: 'Books', path: ['Books'] },
    inheritedFields: [],
    fingerprint: '|',
    problems: [],
    ...overrides,
  };
}

describe('describeToolCall - legacy operations', () => {
  it('list_items (top level)', () => {
    expect(describeToolCall(args({ operation: 'list_items' }), context()).headline).toBe(
      'I will list the top-level items in this workspace to find what to work on.',
    );
  });

  it('list_items (destination)', () => {
    expect(
      describeToolCall(args({ operation: 'list_items', parentId: 'p1' }), context()).headline,
    ).toBe('I will list the items inside the linked destination to find what to work on.');
  });

  it('search', () => {
    expect(
      describeToolCall(args({ operation: 'search', query: 'invoices' }), context()).headline,
    ).toBe('I will search this workspace for “invoices” to find matching items.');
  });

  it('read_item', () => {
    expect(describeToolCall(args({ operation: 'read_item' }), context()).headline).toBe(
      'I will read the linked item’s details and properties.',
    );
  });

  it('read_note', () => {
    expect(describeToolCall(args({ operation: 'read_note' }), context()).headline).toBe(
      'I will read the linked note’s content for context.',
    );
  });

  it('create_note with content, inside a destination', () => {
    expect(
      describeToolCall(
        args({ operation: 'create_note', title: 'Groceries', parentId: 'p1', markdown: 'Milk' }),
        context(),
      ).headline,
    ).toBe(
      'I will create a note named “Groceries” inside the linked destination, with the content shown below.',
    );
  });

  it('create_note without content, top level', () => {
    expect(
      describeToolCall(args({ operation: 'create_note', title: 'Groceries' }), context()).headline,
    ).toBe(
      'I will create a note named “Groceries” at the top level of this workspace, with an empty body.',
    );
  });

  it('append_note', () => {
    expect(describeToolCall(args({ operation: 'append_note' }), context()).headline).toBe(
      'I will add the content below to the end of the linked note, preserving its existing content.',
    );
  });

  it('rename_item', () => {
    expect(
      describeToolCall(args({ operation: 'rename_item', title: 'New title' }), context()).headline,
    ).toBe('I will rename the linked item to “New title”.');
  });

  it('move_item (destination)', () => {
    expect(
      describeToolCall(args({ operation: 'move_item', parentId: 'p1' }), context()).headline,
    ).toBe('I will move the linked item inside the linked destination.');
  });

  it('move_item (top level)', () => {
    expect(describeToolCall(args({ operation: 'move_item' }), context()).headline).toBe(
      'I will move the linked item to the top level of this workspace.',
    );
  });

  it('set_properties', () => {
    expect(describeToolCall(args({ operation: 'set_properties' }), context()).headline).toBe(
      'I will update the linked item with the property values shown below, leaving other properties unchanged.',
    );
  });

  it('trash_item', () => {
    expect(describeToolCall(args({ operation: 'trash_item' }), context()).headline).toBe(
      'I will move the linked item to Trash. It can be restored later.',
    );
  });

  it('restore_item', () => {
    expect(describeToolCall(args({ operation: 'restore_item' }), context()).headline).toBe(
      'I will restore the linked item from Trash.',
    );
  });

  it('apply_template', () => {
    expect(
      describeToolCall(
        args({ operation: 'apply_template', title: 'Reading log', parentId: 'p1' }),
        context(),
      ).headline,
    ).toBe('I will create “Reading log” from the linked template inside the linked destination.');
  });

  it('complete_task names the task, what it becomes, and a repeating occurrence', () => {
    const plain = describeToolCall(
      args({ operation: 'complete_task', specJson: '{"completed":true}' }),
      context({
        taskCompletion: {
          kind: 'property',
          itemId: 'i1',
          title: 'Pay rent',
          key: 'completion',
          completed: true,
          unchanged: false,
        },
      }),
    );
    expect(plain.headline).toBe('I will mark “Pay rent” done.');
    expect(plain.counts.writes).toBe(1);

    const unchanged = describeToolCall(
      args({ operation: 'complete_task', specJson: '{"completed":false}' }),
      context({
        taskCompletion: {
          kind: 'property',
          itemId: 'i1',
          title: 'Pay rent',
          key: 'completion',
          completed: false,
          unchanged: true,
        },
      }),
    );
    expect(unchanged.headline).toBe('I will mark “Pay rent” not done.');
    expect(unchanged.notes).toEqual(['It is already not done, so nothing will change.']);
    expect(unchanged.counts.writes).toBe(0);

    const repeating = describeToolCall(
      args({ operation: 'complete_task', specJson: '{"completed":true}' }),
      context({
        taskCompletion: {
          kind: 'occurrence',
          itemId: 'i1',
          title: 'Water plants',
          occurredOn: '2026-10-09',
        },
      }),
    );
    expect(repeating.headline).toBe(
      'I will mark the 2026-10-09 occurrence of the repeating task “Water plants” done.',
    );
    expect(repeating.notes).toEqual(['The task keeps repeating; its next occurrence stays open.']);
  });

  it('complete_task with a refusal carries it as the problem the card sends back', () => {
    const model = describeToolCall(
      args({ operation: 'complete_task', specJson: '{"completed":true}' }),
      context({
        problems: [
          { path: 'itemId', code: 'task_refused', message: 'Add one with nix_add_fields.' },
        ],
      }),
    );
    expect(model.problems).toHaveLength(1);
  });
});

describe('describeToolCall - new template copy and read_structure', () => {
  it('list_templates', () => {
    expect(describeToolCall(args({ operation: 'list_templates' }), context()).headline).toBe(
      'I will list the templates this workspace can apply.',
    );
  });

  it('read_template', () => {
    expect(describeToolCall(args({ operation: 'read_template' }), context()).headline).toBe(
      'I will read the outline of the linked template.',
    );
  });

  it('read_structure', () => {
    expect(describeToolCall(args({ operation: 'read_structure' }), context()).headline).toBe(
      "I will read the linked item's fields, views and how many children it has.",
    );
  });

  it('apply_template carries the preflight additions and conflicts as notes and a problem', () => {
    const model = describeToolCall(
      args({ operation: 'apply_template', title: 'Reading log' }),
      context({
        preflight: {
          templateId: '11111111-1111-4111-8111-111111111111',
          templateRevision: 1,
          mode: 'create',
          additions: { fields: 2, views: 1, items: 3 },
          conflicts: ['A field named Status already exists'],
          canApply: false,
          initializationPreview: [],
          resolvedInputs: {},
          textBindings: {},
          referenceMappings: {},
        },
      }),
    );
    expect(model.notes).toEqual([
      'Adds 3 items, 2 fields and 1 views.',
      'Conflicts: A field named Status already exists.',
    ]);
    expect(model.problems).toHaveLength(1);
  });
});

describe('describeToolCall - spec operations', () => {
  it('keeps an explicit build destination when a Pet drafts sandbox already exists', () => {
    const plan = planBlueprintPreview(
      {
        version: 1,
        title: 'Reading log',
        summary: 'Track books.',
        root: { id: 'reading-log', title: 'Reading log' },
      },
      'chosen-parent',
      context({ sandboxExists: true }),
    );
    expect(plan.steps[0]).toMatchObject({ kind: 'createItem', parentId: 'chosen-parent' });
  });
  it('a wrongly shaped blueprint yields listed problems, so the pet can fix it', () => {
    const model = describeToolCall(
      args({ operation: 'build_blueprint', specJson: JSON.stringify({ version: 1 }) }),
      context(),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(model.tree).toEqual([]);
    expect(model.problems.map((problem) => problem.path).join(' ')).toContain('title');
  });
  it('an invalid specJson yields problems and no steps', () => {
    const model = describeToolCall(
      args({
        operation: 'create_structured',
        parentId: 'p1',
        title: 'Reading log',
        specJson: 'not json',
      }),
      context(),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(model.tree).toEqual([]);
    expect(model.problems.length).toBeGreaterThan(0);
  });

  it('a spec that fails validation yields problems and no steps', () => {
    const model = describeToolCall(
      args({
        operation: 'create_structured',
        parentId: 'p1',
        title: 'Reading log',
        specJson: JSON.stringify({ recipe: 'drive', fields: [], inherit: true }),
      }),
      context(),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(model.tree).toEqual([]);
    expect(model.problems.length).toBeGreaterThan(0);
  });

  it('compiles and describes a valid create_structured spec, passing model-authored labels through as plain text', () => {
    const model = describeToolCall(
      args({
        operation: 'create_structured',
        parentId: 'p1',
        title: 'Reading log',
        specJson: JSON.stringify({
          recipe: 'board',
          fields: [
            { label: '<b>Status</b>', type: 'select', options: ['To read', 'Reading', 'Done'] },
          ],
          views: [{ kind: 'board', groupBy: '<b>Status</b>' }],
          inherit: true,
        }),
      }),
      context(),
    );
    expect(model.headline).toContain('<b>Status</b>');
    expect(model.problems).toEqual([]);
    expect(model.neverDoes.length).toBeGreaterThan(0);
  });

  it('describes add_fields as a schema-only append', () => {
    const status = {
      key: 'status',
      label: 'Status',
      type: 'select',
      options: ['New'],
      required: false,
    };
    const model = describeToolCall(
      args({
        operation: 'add_fields',
        itemId: 'item-1',
        specJson: JSON.stringify({ fields: [{ label: 'Rating', type: 'number' }] }),
      }),
      context({
        existing: { declared: [status], inherit: true, effective: [status], views: [] },
      }),
    );
    expect(model.headline).toBe(
      'I will add 1 field to Books: Rating (number). No field is removed or changed.',
    );
    expect(model.counts).toMatchObject({ fields: 1, views: 0, writes: 1 });
  });

  it('reports a missing due date value before describing set_recurrence', () => {
    const dueDate = {
      key: 'due_date',
      label: 'Due date',
      type: 'due_date',
      options: [],
      required: false,
    };
    const model = describeToolCall(
      args({
        operation: 'set_recurrence',
        itemId: 'item-1',
        specJson: JSON.stringify({ frequency: 'weekly', interval: 2, weekdays: [1, 4] }),
      }),
      context({
        existing: { declared: [dueDate], inherit: true, effective: [dueDate], views: [] },
      }),
    );
    expect(model.headline).toBe('I cannot run this request as written.');
    expect(
      model.problems.some((problem) => problem.code === 'recurrence-needs-due-date-value'),
    ).toBe(true);
  });
});

describe('describeToolCall - note body edits', () => {
  const scan = {
    unresolvedWikiLinks: 0,
    unresolvedObsidianEmbeds: 0,
    unresolvedLocalImages: 0,
    unsupportedImageAddresses: 0,
    inlineImagesFlattened: 0,
  };
  const section = {
    scope: 'section' as const,
    before: '## Budget\n\nTotal is 400.',
    after: '## Budget\n\nTotal is 450.',
    blocksRemoved: 1,
    blocksAdded: 2,
    losses: [{ kind: 'color-dropped', detail: 'A text-colour mark was dropped.' }],
    markdownChanges: scan,
    fingerprint: 'f',
  };
  const passage = {
    scope: 'list item' as const,
    before: 'Meet at teh station.',
    after: 'Meet at the station.',
    beforeRange: { start: 9, end: 10 },
    afterRange: { start: 9, end: 10 },
    blocksRemoved: 1,
    blocksAdded: 1,
    losses: [],
    markdownChanges: scan,
    fingerprint: 'g',
  };
  const books = context({ destination: { title: 'Trip plan', path: ['Trip plan'] } });

  it('names the section, the subject and the before and after text, with no block counts', () => {
    const model = describeToolCall(
      args({ operation: 'replace_section', query: 'Budget', markdown: 'Total is 450.' }),
      { ...books, bodyEdit: section },
    );
    expect(model.headline).toBe(
      'I will rewrite the section “Budget” in the linked note. The rest of the note stays as it is.',
    );
    expect(model.bodyEdit).toEqual({
      scope: 'section',
      subject: 'Section “Budget” in Trip plan',
      before: section.before,
      after: section.after,
      blocksRemoved: 1,
      blocksAdded: 2,
      losesFormatting: true,
    });
    expect(model.notes).toEqual([]);
    expect(model.counts.writes).toBe(1);
  });

  it('says what a loss does to the section in the future tense', () => {
    const model = describeToolCall(
      args({ operation: 'replace_section', query: 'Budget', markdown: 'x' }),
      { ...books, bodyEdit: section },
    );
    expect(model.warnings).toEqual([
      {
        path: 'This section',
        code: 'color-dropped',
        message: 'Its text colour is removed. The words stay.',
      },
    ]);
  });

  it('names the block a passage sits in and carries the changed ranges', () => {
    const model = describeToolCall(
      args({ operation: 'replace_passage', query: 'teh', markdown: 'the' }),
      { ...books, bodyEdit: { ...passage, losses: [{ kind: 'alignment-dropped', detail: '' }] } },
    );
    expect(model.headline).toBe(
      'I will change one passage in the linked note. The list item it sits in is rewritten; the rest of the note stays as it is.',
    );
    expect(model.bodyEdit).toMatchObject({
      subject: 'List item with “teh” in Trip plan',
      beforeRange: { start: 9, end: 10 },
      afterRange: { start: 9, end: 10 },
      losesFormatting: true,
    });
    expect(model.warnings).toEqual([
      {
        path: 'This list item',
        code: 'alignment-dropped',
        message: 'Its text alignment goes back to the default.',
      },
    ]);
  });

  it('says a passage is removed when nothing replaces it', () => {
    const model = describeToolCall(
      args({ operation: 'replace_passage', query: 'Meet at teh station.', markdown: '' }),
      { ...books, bodyEdit: { ...passage, scope: 'paragraph', after: '', blocksAdded: 0 } },
    );
    expect(model.headline).toBe(
      'I will remove one passage from the linked note. The paragraph it sits in is removed; the rest of the note stays as it is.',
    );
  });

  it('uses a plain sentence for a loss it has no wording for', () => {
    const model = describeToolCall(args({ operation: 'replace_passage', query: 'teh' }), {
      ...books,
      bodyEdit: { ...passage, scope: 'heading', losses: [{ kind: 'unknown-block', detail: '' }] },
    });
    expect(model.warnings[0]).toMatchObject({
      path: 'This heading',
      message: 'Some of its formatting is removed. The words stay.',
    });
  });

  it('carries no comparison when the edit could not be placed', () => {
    const problem = { path: 'find', code: 'body_edit_refused', message: 'Not found.' };
    const model = describeToolCall(
      args({ operation: 'replace_passage', query: 'teh', markdown: 'the' }),
      context({ problems: [problem] }),
    );
    expect(model.bodyEdit).toBeUndefined();
    expect(model.problems).toEqual([problem]);
  });

  it('drops # marks from a section name and shortens long quoted text', () => {
    const section = describeToolCall(
      args({ operation: 'replace_section', query: '## Budget', markdown: 'x' }),
      context({
        destination: { title: 'Trip plan', path: [] },
        bodyEdit: {
          scope: 'section',
          before: 'a',
          after: 'b',
          blocksRemoved: 1,
          blocksAdded: 1,
          losses: [],
          markdownChanges: {
            unresolvedWikiLinks: 0,
            unresolvedObsidianEmbeds: 0,
            unresolvedLocalImages: 0,
            unsupportedImageAddresses: 0,
            inlineImagesFlattened: 0,
          },
          fingerprint: 'f',
        },
      }),
    );
    expect(section.headline).toBe(
      'I will rewrite the section “Budget” in the linked note. The rest of the note stays as it is.',
    );
    expect(section.bodyEdit?.subject).toBe('Section “Budget” in Trip plan');
    const long = 'Book the venue by Friday and then confirm the caterer for Saturday';
    const passage = describeToolCall(
      args({ operation: 'replace_passage', query: long, markdown: 'x' }),
      context({
        destination: { title: 'Trip plan', path: [] },
        bodyEdit: {
          scope: 'paragraph',
          before: long,
          after: 'x',
          blocksRemoved: 1,
          blocksAdded: 1,
          losses: [],
          markdownChanges: {
            unresolvedWikiLinks: 0,
            unresolvedObsidianEmbeds: 0,
            unresolvedLocalImages: 0,
            unsupportedImageAddresses: 0,
            inlineImagesFlattened: 0,
          },
          fingerprint: 'g',
        },
      }),
    );
    expect(passage.bodyEdit?.subject).toBe(
      'Paragraph with “Book the venue by Friday and then confi…” in Trip plan',
    );
  });
});

describe('describeToolCall - run_action', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const workspace = '11111111-1111-4111-8111-111111111111';

  it('shows the request, the risk and every value, and promises no never-list', () => {
    const specJson = JSON.stringify({ path: { itemId: id } });
    const model = describeToolCall(
      args({ operation: 'run_action', query: 'PurgeItem', specJson }),
      context({ actionRun: parseActionRun('PurgeItem', specJson, workspace) }),
    );
    expect(model.headline).toBe('I will run “Permanently delete a trashed item” (PurgeItem).');
    expect(model.warnings.map((warning) => warning.message)).toEqual(['This can’t be undone.']);
    expect(model.notes).toContain(`DELETE /api/v1/items/${id}/purge`);
    expect(model.neverDoes).toEqual([]);
  });
});
