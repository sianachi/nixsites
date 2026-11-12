import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, validateTemplateArchive } from '@nix/export';
import { CATALOG } from './catalog-definitions.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../templates');
const build = resolve(here, 'build-catalog.mjs');

async function catalogBytes() {
  const names = (await readdir(output)).filter((name) => name.endsWith('.nix')).sort();
  return new Map(
    await Promise.all(names.map(async (name) => [name, await readFile(resolve(output, name))])),
  );
}

async function read(bytes) {
  return await readArchive(
    (async function* () {
      yield bytes;
    })(),
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('ships useful archives that pass the production template archive reader', async () => {
  const artifacts = await catalogBytes();
  assert.equal(artifacts.size, 22);
  assert.deepEqual([...artifacts.keys()], CATALOG.map((entry) => `${entry.key}.nix`).sort());

  for (const [name, bytes] of artifacts) {
    const archive = await read(bytes);
    const profile = validateTemplateArchive(archive);
    const definition = CATALOG.find((entry) => `${entry.key}.nix` === name);
    assert.equal(profile.key, name.slice(0, -4));
    assert.ok(archive.bundles.length >= 5, `${name} should contain useful structure`);
    assert.ok(
      archive.bundles.some((item) => item.body !== null),
      `${name} should contain authored prompts`,
    );
    assert.ok(
      archive.bundles.some((item) => item.views?.views.length > 0),
      `${name} should configure a native view`,
    );
    assert.ok(
      profile.initialization.inputs.length > 0,
      `${name} should ask only for its setup values`,
    );
    assert.ok(
      profile.initialization.rules.every((rule) =>
        archive.bundles.some((item) => item.id === rule.sourceId),
      ),
    );
    if (definition.rows !== undefined) {
      assertCollection(name, archive, profile, definition);
      continue;
    }
    const actionContainer = archive.bundles.find((item) => item.title === 'Action items');
    assert.ok(actionContainer, `${name} should group workflow tasks under a native task schema`);
    if (actionContainer !== undefined) {
      assert.deepEqual(
        actionContainer.schema?.declared.map((property) => property.key),
        ['completion', 'due_date', 'assignee', 'priority', 'status'],
      );
      assert.ok(
        actionContainer.views?.views.some((view) =>
          ['board', 'list', 'calendar'].includes(view.kind),
        ),
      );
      for (const task of archive.bundles.filter((item) => item.parentId === actionContainer.id)) {
        assert.equal(task.properties.completion, false, `${name}/${task.title} begins open`);
      }
      const expectedTaskViews = definition.views.filter((kind) =>
        ['board', 'list', 'calendar'].includes(kind),
      );
      for (const kind of expectedTaskViews)
        assert.ok(
          actionContainer.views?.views.some((view) => view.kind === kind),
          `${name} task container should have ${kind}`,
        );
    }
    if (definition.views.includes('gallery')) {
      const pages = archive.bundles.find((item) => item.title === 'Knowledge pages');
      assert.ok(
        pages?.views?.views.some((view) => view.kind === 'gallery'),
        `${name} should configure its actual knowledge pages gallery`,
      );
    }
    if (definition.views.includes('interactive_form')) {
      const intake = archive.bundles.find((item) => item.title === 'Feedback intake');
      assert.ok(intake?.views?.views.some((view) => view.kind === 'interactive_form'));
      const context = intake.schema.properties.find((property) => property.key === 'context');
      const contextBlock = intake.views.views
        .find((view) => view.kind === 'interactive_form')
        .interactiveForm.pages.flatMap((page) => page.blocks)
        .find((block) => block.propertyKey === 'context');
      assert.equal(context.required, false, 'an empty intake template must be installable');
      assert.equal(contextBlock.required, true, 'feedback submissions must include context');
    }
    for (const rule of profile.initialization.rules) {
      if (rule.propertyKey === 'assignee' && rule.kind === 'input') {
        assert.equal(
          profile.initialization.inputs.find((input) => input.key === rule.inputKey)?.type,
          'member',
        );
      }
    }
  }
});

/** A collection template is its root: the library card draws the root's default view. */
function assertCollection(name, archive, profile, definition) {
  const root = archive.bundles.find((item) => item.id === archive.manifest.root);
  const rows = archive.bundles.filter((item) => item.parentId === root.id);
  const declared = new Map(root.schema.declared.map((property) => [property.key, property]));
  assert.equal(root.views.default, root.views.views[0].id, `${name} previews its first view`);
  assert.deepEqual(
    root.views.views.map((view) => view.kind),
    definition.views.map((view) => view.kind),
  );
  assert.equal(rows.length, definition.rows.length);
  assert.deepEqual(
    root.viewRows.map((row) => row.properties),
    rows.map((row) => row.properties),
    `${name} preview rows carry the sample values`,
  );
  for (const row of rows)
    for (const key of Object.keys(row.properties))
      assert.ok(key.startsWith('$habit_') || declared.has(key), `${name}/${row.title}: ${key}`);

  // What Core's import validator refuses: a view that points at a property of the wrong type.
  const typeOf = (key) => declared.get(key)?.type;
  const dates = ['date'];
  const sections = ['select', 'checkbox'];
  for (const view of root.views.views) {
    const at = `${name}/${view.name}`;
    for (const column of view.columns) assert.ok(declared.has(column), `${at} column ${column}`);
    if (view.groupBy !== null) {
      const allowed =
        view.kind === 'chart'
          ? [...sections, ...dates]
          : view.kind === 'board'
            ? ['select']
            : sections;
      assert.ok(allowed.includes(typeOf(view.groupBy)), `${at} groups by ${view.groupBy}`);
      const options = declared.get(view.groupBy).options;
      for (const value of view.groupOrder)
        assert.ok(options.includes(value), `${at} order ${value}`);
    }
    for (const key of [view.dateProperty, view.endDateProperty, view.sortBy])
      if (key != null) assert.ok(dates.includes(typeOf(key)), `${at} date ${key}`);
    if (view.rowBy != null) assert.ok(sections.includes(typeOf(view.rowBy)), `${at} rows`);
    if (view.doneProperty != null) assert.equal(typeOf(view.doneProperty), 'checkbox', at);
    if (view.measureProperty != null) assert.equal(typeOf(view.measureProperty), 'number', at);
    for (const filter of view.filters ?? [])
      assert.ok(declared.has(filter.property), `${at} filters by ${filter.property}`);
    if (['board', 'matrix', 'chart'].includes(view.kind)) assert.ok(view.groupBy, `${at} grouping`);
    if (['calendar', 'timeline'].includes(view.kind)) assert.ok(view.dateProperty, `${at} date`);
    if (view.kind === 'matrix') assert.ok(view.rowBy, `${at} rows`);
    if (view.kind === 'custom') assert.ok(view.program, `${at} program`);
  }
  for (const row of rows)
    for (const [key, value] of Object.entries(row.properties)) {
      const property = declared.get(key);
      if (property?.type === 'select')
        assert.ok(property.options.includes(value), `${name}: ${value}`);
      if (property?.type === 'date') assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    }
  for (const rule of profile.initialization.rules) {
    assert.equal(rule.kind, 'relativeDate');
    assert.equal(typeOf(rule.propertyKey), 'date', `${name} rule ${rule.propertyKey}`);
    assert.equal(
      profile.initialization.inputs.find((input) => input.key === rule.inputKey)?.type,
      'date',
    );
  }
}

test('onboarding fixture carries file bytes, resettable recurrence, links and relative task dates', async () => {
  const bytes = (await catalogBytes()).get('nix.onboarding-plan.nix');
  assert.ok(bytes);
  const archive = await read(bytes);
  const profile = validateTemplateArchive(archive);
  assert.equal(archive.manifest.formatVersion, 2);
  assert.equal(archive.manifest.files?.length, 1);
  assert.equal(archive.manifest.files?.[0]?.fileName, 'team-quick-start.txt');
  assert.deepEqual(
    profile.initialization.inputs.map(({ key, type }) => [key, type]),
    [
      ['starter', 'text'],
      ['manager', 'member'],
      ['start', 'date'],
    ],
  );
  assert.ok(
    profile.initialization.rules.some(
      (rule) =>
        rule.propertyKey === 'due_date' &&
        rule.kind === 'relativeDate' &&
        rule.inputKey === 'start' &&
        rule.offsetDays === 0,
    ),
  );
  const recurring = archive.bundles.find((item) => item.recurrence !== undefined);
  assert.ok(recurring);
  assert.equal(recurring.title, 'Manager check-in');
  assert.deepEqual(recurring.recurrence, {
    freq: 'weekly',
    interval: 1,
    completedThrough: null,
    completed: [],
  });
  assert.ok(
    profile.initialization.references.some(
      (reference) =>
        reference.policy === 'omit' &&
        reference.sourceItemId === '09999999-9999-4999-8999-999999999999',
    ),
  );
  assert.ok(profile.initialization.references.some((reference) => reference.policy === 'omit'));
  const welcome = archive.bundles.find((item) => item.title === 'Welcome');
  const welcomeJson = JSON.stringify(welcome?.body);
  const product = archive.bundles.find((item) => item.title === 'Learn the product');
  assert.ok(product);
  assert.ok(welcomeJson.includes(`nix://item/${product.id}`));
  assert.ok(welcomeJson.includes('nix://item/09999999-9999-4999-8999-999999999999'));
});

test('catalog generation produces byte-identical archives across time zones', async () => {
  const before = await catalogBytes();
  for (const TZ of ['UTC', 'Pacific/Auckland']) {
    const run = spawnSync(process.execPath, [build], {
      cwd: resolve(here, '../..'),
      encoding: 'utf8',
      env: { ...process.env, TZ },
    });
    assert.equal(run.status, 0, run.stderr);
    const after = await catalogBytes();
    assert.deepEqual([...after.keys()], [...before.keys()]);
    for (const [name, bytes] of before)
      assert.equal(sha256(after.get(name)), sha256(bytes), `${TZ}: ${name}`);
  }
});
