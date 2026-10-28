import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '@nix/editor-schema';
import { writeArchive } from '@nix/export';
import { CATALOG } from './catalog-definitions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, '../templates');
const exportedAt = '2026-09-20T00:00:00.000Z';
const workspaceId = '00000000-0000-4000-8000-000000000001';
const textEncoder = new TextEncoder();

await mkdir(outputDirectory, { recursive: true });
for (const definition of CATALOG) {
  validateDefinition(definition);
  const archive = await makeTemplate(definition);
  await writeFile(resolve(outputDirectory, `${definition.key}.nix`), archive);
}

async function makeTemplate(definition) {
  const rootId = stableId(definition.key, 'root');
  const records = [];
  const byKey = new Map();
  const nextSequence = new Map();
  const addRecord = (key, title, kind, prompt, parentId) => {
    if (byKey.has(key)) throw new Error(`${definition.key} repeats node key ${key}.`);
    const id = stableId(definition.key, `node:${key}`);
    const sequence = nextSequence.get(parentId) ?? 0;
    nextSequence.set(parentId, sequence + 1);
    const item = { id, key, parentId, title, kind, prompt, sequence };
    records.push(item);
    byKey.set(key, item);
    return item;
  };

  const taskChildren = definition.children.filter((child) => child[2] === 'task');
  const documentChildren = definition.children.filter((child) => child[2] !== 'task');
  const contentChildren = definition.views.includes('gallery') ? documentChildren : [];
  const directDocuments = contentChildren.length === 0 ? documentChildren : [];

  if (contentChildren.length > 0) {
    addRecord(
      'knowledge-pages',
      'Knowledge pages',
      'content-container',
      'Write one useful page at a time. Keep its purpose, owner and source clear.',
      rootId,
    );
    for (const [key, title, kind, , prompt] of contentChildren)
      addRecord(key, title, kind, prompt, byKey.get('knowledge-pages').id);
  }
  for (const [key, title, kind, , prompt] of directDocuments)
    addRecord(key, title, kind, prompt, rootId);

  if (taskChildren.length > 0) {
    addRecord(
      'actions',
      'Action items',
      'task-container',
      'Give every action one accountable owner, a due date and a finish condition.',
      rootId,
    );
    for (const [key, title, kind, , prompt] of taskChildren)
      addRecord(key, title, kind, prompt, byKey.get('actions').id);
  }

  const taskParent = byKey.get('actions');
  const contentParent = byKey.get('knowledge-pages');
  const rulesByTarget = new Map();
  for (const rule of definition.rules) {
    const target = byKey.get(rule.target);
    if (target === undefined || target.kind !== 'task') {
      throw new Error(
        `${definition.key} rule ${rule.target}.${rule.key} must target a declared task node.`,
      );
    }
    const input = definition.inputs.find(([key]) => key === rule.input);
    if (rule.key === 'assignee' && (rule.kind !== 'input' || input?.[2] !== 'member')) {
      throw new Error(`${definition.key} assignee rules must bind a member input.`);
    }
    if (
      rule.key === 'due_date' &&
      (rule.kind === 'relativeDate'
        ? input?.[2] !== 'date'
        : rule.kind === 'input' && input?.[2] !== 'date')
    ) {
      throw new Error(`${definition.key} due-date rules must bind a date input.`);
    }
    const outputRule =
      rule.kind === 'relativeDate'
        ? {
            sourceId: target.id,
            propertyKey: rule.key,
            kind: rule.kind,
            inputKey: rule.input,
            offsetDays: rule.offset,
          }
        : { sourceId: target.id, propertyKey: rule.key, kind: rule.kind, inputKey: rule.input };
    const existing = rulesByTarget.get(target.id) ?? [];
    if (existing.some((entry) => entry.propertyKey === rule.key))
      throw new Error(`${definition.key} repeats rule ${rule.target}.${rule.key}.`);
    existing.push(outputRule);
    rulesByTarget.set(target.id, existing);
  }

  const file = definition.fileKey === undefined ? null : byKey.get(definition.fileKey);
  if (definition.fileKey !== undefined && file?.kind !== 'file')
    throw new Error(`${definition.key} fileKey must target a declared file node.`);
  if (definition.recurrenceKey !== undefined) {
    const recurring = byKey.get(definition.recurrenceKey);
    if (
      recurring?.kind !== 'task' ||
      !rulesByTarget.get(recurring.id)?.some((rule) => rule.propertyKey === 'due_date')
    ) {
      throw new Error(
        `${definition.key} recurrenceKey must target a task with an initialized due date.`,
      );
    }
  }

  const bundlesById = new Map();
  bundlesById.set(
    rootId,
    makeBundle({
      id: rootId,
      parentId: null,
      title: `${definition.name}: {{${definition.inputs[0][0]}}}`,
      type: 'note',
      seq: '1000',
      body: prose(definition.description),
    }),
  );
  for (const item of records) {
    const isTaskContainer = item.kind === 'task-container';
    const isContentContainer = item.kind === 'content-container';
    const isTask = item.kind === 'task';
    const isFile = item.kind === 'file';
    const viewKinds = isTaskContainer
      ? definition.views.filter(
          (kind) => kind === 'board' || kind === 'list' || kind === 'calendar',
        )
      : isContentContainer
        ? ['gallery', 'list']
        : item.kind === 'form'
          ? ['interactive_form', 'list']
          : [];
    const children = records.filter((candidate) => candidate.parentId === item.id);
    const bodyLinks =
      definition.key === 'nix.onboarding-plan' && item.key === 'welcome'
        ? [
            {
              label: 'Learn the product',
              href: `nix://item/${encodeURIComponent(byKey.get('learn-product').id)}`,
            },
            {
              label: 'Legacy onboarding reference',
              href: 'nix://item/09999999-9999-4999-8999-999999999999',
            },
          ]
        : [];
    const recurrence =
      item.key === definition.recurrenceKey
        ? { freq: 'weekly', interval: 1, completedThrough: null, completed: [] }
        : undefined;
    bundlesById.set(
      item.id,
      makeBundle({
        id: item.id,
        parentId: item.parentId,
        title: item.title,
        type: isFile ? 'file' : 'note',
        seq: String(1000 + item.sequence * 1000),
        properties: isTask ? { completion: false, priority: 3, status: 'Not started' } : {},
        schema: isTaskContainer ? taskSchema() : item.kind === 'form' ? feedbackSchema() : null,
        views: views(viewKinds, isTaskContainer),
        viewRows: isTaskContainer || isContentContainer ? children.map(viewRow) : [],
        body: isFile ? null : prose(item.prompt, bodyLinks),
        ...(recurrence === undefined ? {} : { recurrence }),
      }),
    );
  }

  const initializationRules = records
    .filter((item) => item.kind === 'task')
    .flatMap((item) => [
      { sourceId: item.id, propertyKey: 'completion', kind: 'set', value: false },
      ...(rulesByTarget.get(item.id) ?? []),
    ]);
  const initialization = {
    version: 1,
    inputs: definition.inputs.map(([key, label, type]) => ({ key, label, type, required: true })),
    rules: initializationRules,
    references: definition.references ?? [],
  };
  const itemIds = [rootId, ...records.map((item) => item.id)];
  const fileBytes =
    file === null
      ? null
      : textEncoder.encode(
          'Nix onboarding quick start\n\n1. Sign in and configure multi-factor authentication.\n2. Read the team overview and ask your manager where to get help.\n3. Make one small change with a teammate.\n',
        );
  const files =
    fileBytes === null
      ? undefined
      : [
          {
            itemId: file.id,
            version: 1,
            current: true,
            fileName: 'team-quick-start.txt',
            mediaType: 'text/plain',
            byteLength: fileBytes.byteLength,
            sha256: createHash('sha256').update(fileBytes).digest('hex'),
            previewable: false,
            pixelWidth: null,
            pixelHeight: null,
          },
        ];
  const manifest = {
    format: 'nix-archive',
    formatVersion: files === undefined ? 1 : 2,
    schemaVersion: SCHEMA_VERSION,
    profile: {
      kind: 'template',
      version: 1,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      includeBody: true,
      includeChildren: true,
      initialization,
    },
    exportedAt,
    root: rootId,
    rootEffectiveSchema: null,
    includesDeleted: false,
    items: itemIds.map((id) => {
      const item = bundlesById.get(id);
      return { id, parentId: item.parentId, seq: item.seq, title: item.title, type: item.type };
    }),
    ...(files === undefined ? {} : { files }),
    omitted: [],
    loss: [],
  };
  const bundles = async function* () {
    for (const id of itemIds) yield bundlesById.get(id);
  };
  const archiveFiles =
    fileBytes === null
      ? undefined
      : async function* () {
          yield {
            itemId: file.id,
            version: 1,
            chunks: (async function* () {
              yield fileBytes;
            })(),
          };
        };
  const chunks = [];
  for await (const chunk of writeArchive({
    manifest,
    bundles: bundles(),
    ...(archiveFiles === undefined ? {} : { files: archiveFiles() }),
  }))
    chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function validateDefinition(definition) {
  if (definition.inputs.length === 0 || definition.children.length === 0)
    throw new Error(`${definition.key} must declare inputs and useful child nodes.`);
  const keys = new Set();
  for (const child of definition.children) {
    if (child.length !== 5 || keys.has(child[0]))
      throw new Error(`${definition.key} has an invalid or duplicate stable child key.`);
    keys.add(child[0]);
  }
  for (const rule of definition.rules) {
    if (!keys.has(rule.target))
      throw new Error(`${definition.key} rule target ${rule.target} is not declared.`);
  }
}

function taskSchema() {
  const definitions = [
    ['completion', 'Done', 'completion', []],
    ['due_date', 'Due date', 'due_date', []],
    ['assignee', 'Assignee', 'assignee', []],
    ['priority', 'Priority', 'priority', []],
    ['status', 'Status', 'select', ['Not started', 'In progress', 'Done']],
  ].map(([key, label, type, options]) => ({ key, label, type, options, required: false }));
  return { properties: definitions, declared: definitions, inherit: true };
}

function feedbackSchema() {
  const definitions = [
    ['customer', 'Customer or account'],
    ['context', 'What were you trying to do?'],
    ['contact', 'Can we follow up?'],
    // Requiredness belongs to the submission form. The template itself must be
    // installable while its intake queue is empty.
  ].map(([key, label]) => ({ key, label, type: 'text', options: [], required: false }));
  return { properties: definitions, declared: definitions, inherit: true };
}

function views(kinds, taskFields = false) {
  const snapshots = kinds.map((kind, index) => ({
    id: `${kind}-${index + 1}`,
    name: kind === 'interactive_form' ? 'Feedback intake' : titleCase(kind),
    kind,
    columns:
      !taskFields || kind === 'interactive_form'
        ? []
        : kind === 'board'
          ? ['status', 'assignee', 'due_date']
          : ['completion', 'due_date', 'assignee'],
    groupBy: kind === 'board' ? 'status' : null,
    groupOrder: kind === 'board' ? ['Not started', 'In progress', 'Done'] : [],
    dateProperty: kind === 'calendar' ? 'due_date' : null,
    sortBy: kind === 'calendar' ? 'due_date' : null,
    sortDescending: false,
    mode: null,
    coverProperty: null,
    endDateProperty: null,
    cardSize: null,
    filters: [],
    companionViewId: null,
    companionPlacement: null,
    interactiveForm: kind === 'interactive_form' ? feedbackForm() : null,
  }));
  return snapshots.length ? { views: snapshots, default: snapshots[0].id } : null;
}

function feedbackForm() {
  return {
    pages: [
      {
        id: 'feedback-page',
        title: 'Feedback',
        description: 'Share useful context so the team can follow up.',
        visibleWhen: [],
        blocks: [
          ['customer', 'Customer or account', 'Use a name the team can safely recognize.', false],
          [
            'context',
            'What were you trying to do?',
            'Include the context and what happened.',
            true,
          ],
          [
            'contact',
            'Can we follow up?',
            'Share a safe contact route if the customer agreed.',
            false,
          ],
        ].map(([propertyKey, text, help, required]) => ({
          id: `feedback-${propertyKey}`,
          kind: 'field',
          propertyKey,
          text,
          help,
          required,
          identityRole: null,
          visibleWhen: [],
        })),
      },
    ],
    titleMode: 'generated',
    titleFieldBlockId: null,
    confirmationTitle: 'Thank you',
    confirmationMessage: 'Your feedback was recorded for review.',
  };
}

function viewRow(item) {
  return {
    id: item.id,
    title: item.title,
    properties:
      item.kind === 'task' ? { completion: false, priority: 3, status: 'Not started' } : {},
  };
}

function makeBundle({
  id,
  parentId,
  title,
  type,
  seq,
  properties = {},
  schema = null,
  views: itemViews = null,
  viewRows = [],
  body,
  recurrence,
}) {
  return {
    id,
    parentId,
    workspaceId,
    type,
    title,
    seq,
    lifecycleState: 'active',
    createdAt: exportedAt,
    updatedAt: exportedAt,
    properties,
    ...(recurrence === undefined ? {} : { recurrence }),
    schema,
    views: itemViews,
    viewRows,
    viewRowsTruncated: false,
    body,
  };
}

function prose(value, links = []) {
  const content = [{ type: 'text', text: value }];
  for (const link of links)
    content.push(
      { type: 'text', text: ' See ' },
      {
        type: 'text',
        text: link.label,
        marks: [{ type: 'link', attrs: { href: link.href, target: null, rel: null, class: null } }],
      },
    );
  return {
    schemaVersion: SCHEMA_VERSION,
    prosemirror: { type: 'doc', content: [{ type: 'paragraph', content }] },
  };
}

function stableId(templateKey, nodeKey) {
  const bytes = createHash('sha256')
    .update(`nix-template-source-v1\0${templateKey}\0${nodeKey}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function titleCase(value) {
  return value
    .split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}
