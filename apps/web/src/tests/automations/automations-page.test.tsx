import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { item, stubCoreApi, STUB_WORKSPACE_ID } from '@nix/web-foundation/testing/api-stub';
import {
  automationRule,
  stubAutomations,
  type StubAutomationRun,
} from '@nix/web-foundation/testing/api-stub/automations';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { App } from '../../app';
import { stubViewport } from '@nix/web-foundation/testing/stub-viewport';

const RULE_ID = 'a1111111-1111-4111-8111-111111111111';
const OTHER_ID = 'a2222222-2222-4222-8222-222222222222';
const SCOPE_ID = 'b1111111-1111-4111-8111-111111111111';
const ITEM_ID = 'b2222222-2222-4222-8222-222222222222';
const PAGE = `/w/${STUB_WORKSPACE_ID}/automations`;

function run(id: string, overrides: Partial<StubAutomationRun> = {}): StubAutomationRun {
  return {
    id,
    ruleId: RULE_ID,
    itemId: null,
    origin: 'schedule',
    depth: 0,
    status: 'succeeded',
    reason: null,
    createdAt: '2026-09-29T16:00:00+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  signedIn();
});

describe('the automations list', () => {
  it('is its own address and says so when there are none', async () => {
    stubCoreApi();
    stubAutomations();
    renderAt(<App />, PAGE);

    expect(await screen.findByRole('heading', { level: 1, name: 'Automations' })).toBeVisible();
    expect(await screen.findByText('No automations yet')).toBeVisible();
  });

  it('lists each rule with its trigger, last run and whether it is on', async () => {
    stubCoreApi();
    stubAutomations({
      rules: [
        automationRule({ id: RULE_ID, lastRunAt: '2026-09-29T16:00:00+00:00' }),
        automationRule({
          id: OTHER_ID,
          name: 'Chase overdue',
          enabled: false,
          disabledReason: 'repeated_failures',
          consecutiveFailures: 5,
          trigger: { type: 'date_arrives', key: 'due_date', offsetMinutes: -1440, time: '09:00' },
        }),
      ],
    });
    renderAt(<App />, PAGE);

    const list = await screen.findByRole('list', { name: 'Your automations' });
    expect(within(list).getByRole('link', { name: 'Weekly review' })).toHaveAttribute(
      'href',
      `${PAGE}?rule=${RULE_ID}`,
    );
    expect(within(list).getByText('Every week on Friday at 16:00')).toBeVisible();
    expect(within(list).getByText('1 day before due_date arrives')).toBeVisible();
    expect(within(list).getByRole('checkbox', { name: 'Turn on Weekly review' })).toBeChecked();
    expect(within(list).getByRole('checkbox', { name: 'Turn on Chase overdue' })).not.toBeChecked();
    expect(within(list).getByText(/Turned off after five failed runs in a row/)).toBeVisible();
    expect(within(list).getByText('Has not run yet')).toBeVisible();
  });

  it('turns a rule off at the revision it read', async () => {
    stubCoreApi();
    const writes = stubAutomations({ rules: [automationRule({ id: RULE_ID, revision: 4 })] });
    renderAt(<App />, PAGE);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Turn on Weekly review' }));

    await waitFor(() => {
      expect(writes.updates).toHaveLength(1);
    });
    expect(writes.updates[0]?.body).toMatchObject({
      expectedRevision: 4,
      rule: { enabled: false, name: 'Weekly review' },
    });
    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: 'Turn on Weekly review' })).not.toBeChecked();
    });
  });

  it.each([280, 320, 768])(
    'offers rule actions at width %i without hiding long names',
    async (width) => {
      stubViewport(width);
      stubCoreApi();
      const name = 'A weekly review with a long title that must stay readable on a small screen';
      const writes = stubAutomations({ rules: [automationRule({ id: RULE_ID, name })] });
      renderAt(<App />, PAGE);
      const user = userEvent.setup();
      const rule = await screen.findByRole('link', { name });
      expect(rule).not.toHaveClass('truncate');
      await user.pointer({ target: rule, keys: '[MouseRight]' });
      const menu = await screen.findByRole('menu', { name: `${name} actions` });
      await user.click(within(menu).getByRole('menuitem', { name: 'Pause automation' }));
      await waitFor(() => {
        expect(writes.updates[0]?.body).toMatchObject({ rule: { enabled: false, name } });
        expect(screen.getByRole('checkbox', { name: `Turn on ${name}` })).not.toBeChecked();
      });
      await user.pointer({ target: rule, keys: '[MouseRight]' });
      const reopened = await screen.findByRole('menu', { name: `${name} actions` });
      await user.click(within(reopened).getByRole('menuitem', { name: 'Edit automation' }));
      expect(await screen.findByRole('heading', { name: `Edit ${name}` })).toBeVisible();
      expect(screen.getByLabelText('Name')).toHaveValue(name);
    },
  );

  it('shows an error with a way to try again when the list cannot load', async () => {
    stubCoreApi();
    stubAutomations({ listFails: true });
    renderAt(<App />, PAGE);

    expect(await screen.findByText('Your automations could not be loaded')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('creating an automation', () => {
  it('builds a weekly schedule rule and opens it once created', async () => {
    stubCoreApi();
    const writes = stubAutomations();
    renderAt(<App />, `${PAGE}?new=1`);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Friday review');
    await user.selectOptions(screen.getByLabelText('Repeats'), 'weekly');
    await user.click(screen.getByRole('checkbox', { name: 'Friday' }));
    const time = screen.getByLabelText('At');
    await user.clear(time);
    await user.type(time, '16:30');
    await user.type(screen.getByLabelText('Action 1 title'), 'Review the week');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    await waitFor(() => {
      expect(writes.creates).toHaveLength(1);
    });
    expect(writes.creates[0]).toEqual({
      name: 'Friday review',
      enabled: true,
      scopeItemId: null,
      trigger: { type: 'schedule', freq: 'weekly', interval: 1, weekdays: ['fr'], time: '16:30' },
      conditions: [],
      actions: [{ type: 'notify', title: 'Review the week', body: '' }],
    });
    expect(await screen.findByRole('heading', { name: 'Edit Friday review' })).toBeVisible();
  });

  it('checks the draft before sending and names each problem at its field', async () => {
    stubCoreApi();
    const writes = stubAutomations();
    renderAt(<App />, `${PAGE}?new=1`);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create automation' }));

    expect(await screen.findByText('Give the automation a name.')).toBeVisible();
    expect(screen.getByText('Give the notification a title.')).toBeVisible();
    expect(writes.creates).toHaveLength(0);
  });

  it('prefills the scope from the item menu and offers the scope’s properties', async () => {
    stubCoreApi({
      items: [item({ id: SCOPE_ID, title: 'Projects' })],
      schemas: {
        [SCOPE_ID]: {
          properties: [
            {
              key: 'status',
              label: 'Status',
              type: 'select',
              options: ['Open', 'Done'],
              required: false,
            },
          ],
          declared: [],
          inherit: true,
        },
      },
    });
    const writes = stubAutomations();
    renderAt(<App />, `${PAGE}?new=1&scope=${SCOPE_ID}`);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Close out');
    expect(screen.getByLabelText('Trigger')).toHaveValue('property_changed');
    await user.type(screen.getByLabelText('Property'), 'status');
    await user.selectOptions(screen.getByLabelText('Changes to'), 'value');
    await user.selectOptions(await screen.findByLabelText('Changes to, value'), 'Done');
    await user.type(screen.getByLabelText('Action 1 title'), 'Closed {{item.title}');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    await waitFor(() => {
      expect(writes.creates).toHaveLength(1);
    });
    expect(writes.creates[0]).toMatchObject({
      scopeItemId: SCOPE_ID,
      trigger: { type: 'property_changed', key: 'status', to: { value: 'Done' } },
    });
  });

  it('puts the server’s refusal beside the field it names', async () => {
    stubCoreApi();
    stubAutomations({ invalidDetail: 'trigger.timeZone: is not a known IANA time zone' });
    renderAt(<App />, `${PAGE}?new=1`);

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'Zoned');
    await user.type(screen.getByLabelText('Time zone'), 'Mars/Olympus');
    await user.type(screen.getByLabelText('Action 1 title'), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(await screen.findByText('Is not a known IANA time zone.')).toBeVisible();
    expect(screen.getByText('Trigger: is not a known IANA time zone')).toBeVisible();
  });
});

describe('one automation', () => {
  it('offers to reload after a revision conflict, and reloading shows the saved version', async () => {
    stubCoreApi();
    const writes = stubAutomations({
      rules: [automationRule({ id: RULE_ID })],
      conflictOnce: true,
    });
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed here');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/changed since you opened it/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload the saved automation' }));

    expect(await screen.findByDisplayValue('Weekly review (changed elsewhere)')).toBeVisible();
    expect(screen.queryByText(/changed since you opened it/)).not.toBeInTheDocument();
    expect(writes.updates).toHaveLength(1);
  });

  it('pages the run log and says each reason in words', async () => {
    stubCoreApi();
    const writes = stubAutomations({
      rules: [automationRule({ id: RULE_ID })],
      runs: {
        [RULE_ID]: [
          run('d0000000-0000-4000-8000-000000000001'),
          run('d0000000-0000-4000-8000-000000000002', {
            status: 'skipped',
            reason: 'conditions_unmet',
            itemId: ITEM_ID,
          }),
          run('d0000000-0000-4000-8000-000000000003', {
            status: 'skipped',
            reason: 'scope_locked',
          }),
        ],
      },
    });
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    const log = await screen.findByRole('list', { name: 'Runs, newest first' });
    expect(within(log).getByText('The conditions were not met.')).toBeVisible();
    expect(within(log).getByRole('link', { name: 'Open the item' })).toHaveAttribute(
      'href',
      `/w/${STUB_WORKSPACE_ID}?item=${ITEM_ID}`,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show older runs' }));
    expect(await within(log).findByText('The scope item is locked.')).toBeVisible();
    expect(writes.runPages).toEqual([null, '2']);
    expect(screen.queryByRole('button', { name: 'Show older runs' })).not.toBeInTheDocument();
  });

  it('tests without writing and runs for real', async () => {
    stubCoreApi();
    const writes = stubAutomations({
      rules: [automationRule({ id: RULE_ID })],
      testResult: {
        wouldRun: true,
        reason: null,
        actions: [
          {
            index: 0,
            type: 'notify',
            itemId: null,
            key: null,
            title: 'Time for the weekly review',
            body: null,
          },
        ],
      },
      runResult: { status: 'skipped', reason: 'throttled' },
    });
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Send you "Time for the weekly review"')).toBeVisible();
    expect(writes.tests).toEqual([{ ruleId: RULE_ID, itemId: null }]);

    await user.click(screen.getByRole('button', { name: 'Run now' }));
    expect(
      await screen.findByText(/Skipped\.\s+Skipped to stay within the run limits\./),
    ).toBeVisible();
    expect(writes.runs).toEqual([{ ruleId: RULE_ID, itemId: null }]);
    const log = await screen.findByRole('list', { name: 'Runs, newest first' });
    expect(await within(log).findByText('Run now')).toBeVisible();
  });

  it('deletes only after the dialog confirms, then returns to the list', async () => {
    stubCoreApi();
    const writes = stubAutomations({ rules: [automationRule({ id: RULE_ID })] });
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Delete automation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Weekly review?' });
    expect(writes.deletes).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Delete automation' }));
    await waitFor(() => {
      expect(writes.deletes).toEqual([RULE_ID]);
    });
    expect(await screen.findByText('No automations yet')).toBeVisible();
  });

  it('shows a rule a newer build wrote read-only, still with its tools', async () => {
    stubCoreApi();
    stubAutomations({
      rules: [automationRule({ id: RULE_ID, trigger: { type: 'webhook', secret: 'x' } })],
    });
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    expect(await screen.findByText(/cannot edit, so it is shown read-only/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete automation' })).toBeVisible();
  });

  it('says a rule it cannot find is unavailable rather than loading forever', async () => {
    stubCoreApi();
    stubAutomations();
    renderAt(<App />, `${PAGE}?rule=${RULE_ID}`);

    expect(await screen.findByText('This automation is not available')).toBeVisible();
  });
});
