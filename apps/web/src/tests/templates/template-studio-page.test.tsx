import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { App } from '../../app';
import {
  item,
  STUB_TEMPLATES,
  STUB_WORKSPACE,
  stubCoreApi,
} from '@nix/web-foundation/testing/api-stub';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { findByAriaLabel } from '@nix/web-foundation/testing/by-aria-label';

const SOURCE = item({
  id: 'a9999999-9999-4999-8999-999999999999',
  title: 'Team project',
});
const OTHER_DESTINATION = item({
  id: 'a8888888-8888-4888-8888-888888888888',
  title: 'Operations',
});
const KANBAN_TEMPLATE_ID = 'a1111111-1111-4111-8111-111111111111';
const CAPTURE_FIELD = {
  key: 'priority',
  label: 'Priority',
  type: 'text',
  options: [],
  required: false,
};
const CAPTURE_VIEW = {
  id: 'work-list',
  name: 'Work list',
  kind: 'list',
  columns: ['title', 'priority'],
  groupBy: null,
  groupOrder: [],
  dateProperty: null,
  sortBy: null,
  sortDescending: false,
  mode: null,
  coverProperty: null,
  endDateProperty: null,
  cardSize: null,
  layout: null,
  filters: [],
  companionViewId: null,
  companionPlacement: null,
  interactiveForm: null,
};

beforeEach(() => {
  signedIn();
  sessionStorage.clear();
});

describe('the template studio', () => {
  it('protects body and child data by default, then captures the choices explicitly made', async () => {
    const user = userEvent.setup();
    stubCoreApi({
      items: [SOURCE],
      schemas: {
        [SOURCE.id]: {
          properties: [CAPTURE_FIELD],
          declared: [CAPTURE_FIELD],
          inherit: true,
        },
      },
      views: { [SOURCE.id]: { views: [CAPTURE_VIEW], default: CAPTURE_VIEW.id } },
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('heading', { name: 'Save as template' })).toBeVisible();
    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Team project');
    const preview = await findByAriaLabel('Template preview');
    await waitFor(() => {
      expect(within(preview).getByText('Fields').parentElement).toHaveTextContent('1');
      expect(within(preview).getByText('Views').parentElement).toHaveTextContent('1');
    });
    expect(within(preview).getByText('list')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const body = screen.getByRole('checkbox', { name: /include document content/i });
    const children = screen.getByRole('checkbox', { name: /include everything inside/i });
    expect(body).not.toBeChecked();
    expect(children).not.toBeChecked();
    await user.click(body);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Save template' }));

    expect(await screen.findByRole('heading', { name: 'Team project' })).toBeVisible();
    expect(screen.getByText('Content')).toBeVisible();
  });

  it('gives both narrow-screen template regions their own bounded scroller', async () => {
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    await screen.findByRole('heading', { name: 'Save as template' });
    const preview = await findByAriaLabel('Template preview');
    expect(preview.previousElementSibling).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
    expect(preview).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', '@4xl/studio:flex-none');
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  /**
   * A regression for the phone-width step bar: it used to hide every step's name below `lg`,
   * leaving only bare numbers - "1 2 3" tells a reader there are three steps and nothing about
   * what any of them are. The name for the current step now renders at every width, so this reads
   * it as a fact about the DOM rather than about a breakpoint no test here can evaluate.
   */
  it('names the current step, not only its number, regardless of width', async () => {
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    await screen.findByRole('heading', { name: 'Save as template' });
    const steps = screen.getByRole('navigation', { name: 'Template steps' });
    const current = within(steps).getByRole('button', { current: 'step' });

    const name = within(current).getByText('Basics');
    expect(name).toBeVisible();
    expect(name).not.toHaveClass('sr-only');
    expect(name.parentElement).not.toHaveClass('hidden');
  });

  it('asks before discarding on Escape and keeps the action row outside the scroller', async () => {
    const user = userEvent.setup();
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    await screen.findByRole('heading', { name: 'Save as template' });
    const setup = screen.getByRole('region', { name: 'Template setup' });
    expect(within(setup).queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(await screen.findByRole('dialog', { name: 'Discard this setup?' })).toBeVisible();
  });

  it('recovers an unfinished draft for the same source item', async () => {
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:capture:source:${SOURCE.id}`,
      JSON.stringify({
        scope: `source:${SOURCE.id}`,
        title: 'Recovered project template',
        description: 'Saved in this tab.',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000000',
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    stubCoreApi({ items: [SOURCE] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue(
      'Recovered project template',
    );
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Saved in this tab.');
  });

  it('does not recover a studio draft saved for another workspace', async () => {
    const otherWorkspace = {
      ...STUB_WORKSPACE,
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Other workspace',
      kind: 'shared' as const,
    };
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:capture:source:${SOURCE.id}`,
      JSON.stringify({
        scope: `source:${SOURCE.id}`,
        title: 'Private draft from workspace A',
        description: '',
        includeBody: true,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000000',
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    stubCoreApi({ items: [SOURCE], workspaces: [STUB_WORKSPACE, otherWorkspace] });
    renderAt(<App />, `/w/${otherWorkspace.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Team project');
    expect(screen.queryByDisplayValue('Private draft from workspace A')).not.toBeInTheDocument();
  });

  it('offers a retry when template access cannot be checked', async () => {
    stubCoreApi({ items: [SOURCE], templatesFail: true });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/new?sourceItem=${SOURCE.id}`);

    expect(
      await screen.findByRole('heading', { name: 'Template access could not be checked' }),
    ).toBeVisible();
    expect(await screen.findByText(/template library could not be loaded/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Template creation unavailable' }),
    ).not.toBeInTheDocument();
  });

  it('checks conflicts before a direct rail jump can reach review', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({
      items: [SOURCE],
      templatePreflightCanApply: false,
      templatePreflightConflicts: ['A Status field already exists.'],
    });
    renderAt(<App />, `/items/${SOURCE.id}/templates/apply/${KANBAN_TEMPLATE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Apply Kanban' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Review/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A Status field already exists.');
    expect(screen.queryByRole('heading', { name: 'Review' })).not.toBeInTheDocument();
    expect(writes.templatePreflights).toMatchObject([
      {
        mode: 'merge',
        targetItemId: SOURCE.id,
        parentItemId: null,
        title: null,
        inputs: {},
        expectedRevision: 1,
      },
    ]);
  });

  it('keeps a cleared optional default empty, blocks missing required answers, and previews resolved values', async () => {
    const user = userEvent.setup();
    const template = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (template === undefined) return;
    const sourceId = `b${template.id.slice(1)}`;
    const configured = {
      ...template,
      initialization: {
        version: 1 as const,
        inputs: [
          {
            key: 'project_name',
            label: 'Project name',
            type: 'text' as const,
            required: false,
            defaultValue: 'Default project',
          },
          {
            key: 'team_name',
            label: 'Team name',
            type: 'text' as const,
            required: true,
            defaultValue: null,
          },
          {
            key: 'optional_note',
            label: 'Optional note',
            type: 'text' as const,
            required: false,
            defaultValue: null,
          },
        ],
        rules: [],
        references: [],
      },
    };
    const writes = stubCoreApi({
      templates: [configured],
      templatePreflightPreview: [
        {
          sourceId,
          title: 'Personalized project',
          properties: { title: 'Personalized project' },
          recurrence: null,
        },
      ],
    });
    renderAt(<App />, `/templates/${KANBAN_TEMPLATE_ID}/create`);

    const projectName = await screen.findByRole('textbox', { name: 'Project name' });
    expect(projectName).toHaveValue('Default project');
    expect(await screen.findByRole('textbox', { name: 'Optional note' })).toHaveValue('');
    await user.clear(projectName);
    expect(projectName).toHaveValue('');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    expect(await screen.findByText('Enter Team name to continue.')).toBeVisible();
    expect(writes.templatePreflights).toHaveLength(0);

    await user.type(screen.getByRole('textbox', { name: 'Team name' }), 'Delivery');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    const resolved = await screen.findByLabelText('Resolved template preview');
    expect(within(resolved).getAllByText('Personalized project')).toHaveLength(2);
    expect(writes.templatePreflights).toMatchObject([
      { inputs: { project_name: '', team_name: 'Delivery' }, expectedRevision: template.revision },
    ]);
    expect(writes.templatePreflights[0]?.inputs).toEqual({
      project_name: '',
      team_name: 'Delivery',
    });

    await user.click(screen.getByRole('button', { name: 'Create item' }));
    expect(writes.templateApplications[0]).toMatchObject({
      inputs: { project_name: '', team_name: 'Delivery' },
      expectedRevision: template.revision,
    });
  });

  it('keeps a relative date rule date-only when its time fields are null', async () => {
    const user = userEvent.setup();
    const template = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (template === undefined) return;
    const sourceId = `b${template.id.slice(1)}`;
    const dueDate = {
      key: 'dueDate',
      label: 'Due date',
      type: 'date',
      options: [],
      required: false,
    };
    const configured = {
      ...template,
      origin: 'user' as const,
      capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
      initialization: {
        version: 1 as const,
        inputs: [
          {
            key: 'start_date',
            label: 'Start date',
            type: 'date' as const,
            required: true,
            defaultValue: null,
          },
        ],
        rules: [
          {
            sourceId,
            propertyKey: 'dueDate',
            kind: 'relativeDate' as const,
            inputKey: 'start_date',
            offsetDays: 0,
            timeOfDay: null,
            timeZone: null,
          },
        ],
        references: [],
      },
      root: {
        sourceId,
        itemType: 'task',
        title: template.title,
        seq: '1',
        properties: { title: template.title, dueDate: null },
        schema: { properties: [dueDate], declared: [dueDate], inherit: false },
        views: null,
        hasBody: false,
        recurrence: null,
        children: [],
      },
    };
    stubCoreApi({ templates: [configured] });
    renderAt(<App />, `/templates/${KANBAN_TEMPLATE_ID}/edit`);

    expect(await screen.findByRole('heading', { name: /edit kanban/i })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const useTime = await screen.findByRole('checkbox', { name: 'Set a time and time zone' });
    expect(useTime).not.toBeChecked();
    expect(screen.queryByLabelText('Time')).not.toBeInTheDocument();
  });

  it('waits for a pending template file copy and replays the same application request', async () => {
    const user = userEvent.setup();
    const writes = stubCoreApi({ templateApplicationFileTransferPending: true });
    renderAt(<App />, `/templates/${KANBAN_TEMPLATE_ID}/create`);

    expect(await screen.findByRole('button', { name: /Review/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));

    await waitFor(() => {
      expect(writes.templateApplications).toHaveLength(2);
    });
    expect(writes.templateApplications[0]?.idempotencyKey).toBe(
      writes.templateApplications[1]?.idempotencyKey,
    );
  });

  it('lets Core resolve authored root title bindings unless the user overrides the title', async () => {
    const user = userEvent.setup();
    const template = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (template === undefined) return;
    const configured = {
      ...template,
      root: {
        sourceId: SOURCE.id,
        itemType: 'note',
        title: 'Kick off {{project_name}}',
        seq: '1',
        properties: {},
        schema: { properties: [], declared: [], inherit: false },
        views: null,
        hasBody: false,
        recurrence: null,
        children: [],
      },
      initialization: {
        version: 1 as const,
        inputs: [
          {
            key: 'project_name',
            label: 'Project name',
            type: 'text' as const,
            required: true,
            defaultValue: null,
          },
        ],
        rules: [],
        references: [],
      },
    };
    const writes = stubCoreApi({ templates: [configured] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/${KANBAN_TEMPLATE_ID}/create`);

    const name = await screen.findByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Kick off {{project_name}}');
    await user.type(await screen.findByRole('textbox', { name: 'Project name' }), 'Apollo');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));
    expect(writes.templateApplications[0]).not.toHaveProperty('title');
  });

  it('keeps an explicitly edited item title when the source root title has bindings', async () => {
    const user = userEvent.setup();
    const template = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (template === undefined) return;
    const configured = {
      ...template,
      root: {
        sourceId: SOURCE.id,
        itemType: 'note',
        title: 'Kick off {{project_name}}',
        seq: '1',
        properties: {},
        schema: { properties: [], declared: [], inherit: false },
        views: null,
        hasBody: false,
        recurrence: null,
        children: [],
      },
      initialization: {
        version: 1 as const,
        inputs: [
          {
            key: 'project_name',
            label: 'Project name',
            type: 'text' as const,
            required: true,
            defaultValue: null,
          },
        ],
        rules: [],
        references: [],
      },
    };
    const writes = stubCoreApi({ templates: [configured] });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/${KANBAN_TEMPLATE_ID}/create`);

    const name = await screen.findByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Custom setup');
    await user.type(await screen.findByRole('textbox', { name: 'Project name' }), 'Apollo');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));
    expect(writes.templateApplications[0]).toMatchObject({ title: 'Custom setup' });
  });

  it('offers group-derived active principals as template member answers', async () => {
    const user = userEvent.setup();
    const template = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(template).toBeDefined();
    if (template === undefined) return;
    const groupPersonId = 'a7777777-7777-4777-8777-777777777777';
    const configured = {
      ...template,
      initialization: {
        version: 1 as const,
        inputs: [
          {
            key: 'assignee',
            label: 'Assignee',
            type: 'member' as const,
            required: true,
            defaultValue: null,
          },
        ],
        rules: [],
        references: [],
      },
    };
    const writes = stubCoreApi({
      templates: [configured],
      workspacePrincipals: [
        { principalId: groupPersonId, displayName: 'Group team member', kind: 'user' },
      ],
    });
    renderAt(<App />, `/w/${STUB_WORKSPACE.id}/templates/${KANBAN_TEMPLATE_ID}/create`);

    const assignee = await screen.findByRole('combobox', { name: 'Assignee' });
    await waitFor(() =>
      expect(within(assignee).getByRole('option', { name: 'Group team member' })).toBeVisible(),
    );
    await user.selectOptions(assignee, groupPersonId);
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));

    expect(writes.templatePreflights[0]).toMatchObject({ inputs: { assignee: groupPersonId } });
    expect(writes.templateApplications[0]).toMatchObject({ inputs: { assignee: groupPersonId } });
  });

  it('announces when a recovered template draft has expired and offers recovery actions', async () => {
    const operationId = 'a0000000-0000-4000-8000-000000000009';
    sessionStorage.setItem(
      `nix:template-studio:${STUB_WORKSPACE.id}:edit:template:${KANBAN_TEMPLATE_ID}`,
      JSON.stringify({
        scope: `template:${KANBAN_TEMPLATE_ID}`,
        title: 'Recovered name',
        description: '',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: 'a0000000-0000-4000-8000-000000000010',
        operationId,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    const seed = STUB_TEMPLATES.find((candidate) => candidate.id === KANBAN_TEMPLATE_ID);
    expect(seed).toBeDefined();
    if (seed === undefined) return;
    const editable = {
      ...seed,
      origin: 'user' as const,
      capabilities: { canEdit: true, canDelete: true, canExport: true, canApply: true },
    };
    stubCoreApi({ templates: [editable], templateDraftUnavailable: true });
    renderAt(<App />, `/templates/${KANBAN_TEMPLATE_ID}/edit`);

    expect(
      await screen.findByRole('heading', { name: 'This saved draft is no longer available' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try to resume again' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start a fresh draft' })).toBeVisible();
  });

  it('keeps recovered apply drafts isolated to their exact target item', async () => {
    const user = userEvent.setup();
    const previousKey = 'a0000000-0000-4000-8000-000000000001';
    const sourceScope = `template:${KANBAN_TEMPLATE_ID}:target:${SOURCE.id}`;
    sessionStorage.setItem(
      `nix:template-studio:apply:template:${KANBAN_TEMPLATE_ID}:target:${OTHER_DESTINATION.id}`,
      JSON.stringify({
        scope: sourceScope,
        title: 'Kanban',
        description: '',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: previousKey,
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    const writes = stubCoreApi({ items: [SOURCE, OTHER_DESTINATION] });
    renderAt(<App />, `/items/${OTHER_DESTINATION.id}/templates/apply/${KANBAN_TEMPLATE_ID}`);

    expect(await screen.findByRole('heading', { name: 'Apply Kanban' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Apply template' }));

    expect(writes.templateApplications).toHaveLength(1);
    expect(writes.templateApplications[0]).toMatchObject({
      templateId: KANBAN_TEMPLATE_ID,
      mode: 'merge',
      targetItemId: OTHER_DESTINATION.id,
    });
    expect(writes.templateApplications[0]?.idempotencyKey).not.toBe(previousKey);
  });

  it('keeps recovered create drafts isolated to their exact parent destination', async () => {
    const user = userEvent.setup();
    const previousKey = 'a0000000-0000-4000-8000-000000000002';
    const rootScope = `template:${KANBAN_TEMPLATE_ID}:parent:root`;
    sessionStorage.setItem(
      `nix:template-studio:create:template:${KANBAN_TEMPLATE_ID}:parent:${OTHER_DESTINATION.id}`,
      JSON.stringify({
        scope: rootScope,
        title: 'Wrong recovered title',
        description: '',
        includeBody: false,
        includeChildren: false,
        idempotencyKey: previousKey,
        operationId: null,
        expiresAt: null,
        selectedSourceId: null,
        itemEdits: {},
      }),
    );
    const writes = stubCoreApi({ items: [OTHER_DESTINATION] });
    renderAt(
      <App />,
      `/w/${STUB_WORKSPACE.id}/templates/${KANBAN_TEMPLATE_ID}/create?parent=${OTHER_DESTINATION.id}`,
    );

    expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Kanban');
    await user.click(screen.getByRole('button', { name: /Review/ }));
    await user.click(await screen.findByRole('button', { name: 'Create item' }));

    expect(writes.templateApplications).toHaveLength(1);
    expect(writes.templateApplications[0]).toMatchObject({
      templateId: KANBAN_TEMPLATE_ID,
      mode: 'create',
      parentItemId: OTHER_DESTINATION.id,
      title: 'Kanban',
    });
    expect(writes.templateApplications[0]?.idempotencyKey).not.toBe(previousKey);
  });
});
