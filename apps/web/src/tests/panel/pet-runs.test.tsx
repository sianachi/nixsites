import type { PetRunResponse } from '@nix/api-client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clearPetDrafts } from '@nix/web-foundation/lib/pet-drafts';
import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { expect, it, vi } from 'vitest';
import { App } from '../../app';
import { petJobHref } from '../../pages/editor/pet-job-routing';

const task = item({ id: '11fa1d13-ce45-47d4-bd7c-51a4dd47e4ab', title: 'Review the estimate' });
const source = item({
  id: '22fa1d13-ce45-47d4-bd7c-51a4dd47e4ab',
  title: 'Cost notes',
  workspaceId: task.workspaceId,
});
const runId = '33fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const questionId = '44fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const proposalId = '55fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const route = `/api/v1/items/${task.id}/pet-runs`;
const chatRoute = '/api/v1/me/pets/runtime/note';
const workspaceChatRoute = '/api/v1/me/pets/runtime';
const routinesRoute = `/api/v1/workspaces/${task.workspaceId}/automations`;
const routineId = '66fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const petId = '77fa1d13-ce45-47d4-bd7c-51a4dd47e4ab';
const brief = 'Draft a comment on the estimate after reviewing it.';
const dialogLoad = { timeout: 5_000 };
const ability = {
  id: 'task.comment',
  name: 'Post a comment',
  description: 'Prepare a comment for review',
};
const rename = { id: 'task.rename', name: 'Rename the task', description: 'Prepare a new title' };
const renamedTitle = 'Review the updated estimate';
const question = { id: questionId, text: 'Which estimate should I review?' };
const scopeQuestion = {
  id: questionId,
  text: 'I need the estimate notes.',
  scope: 'source',
} as const;
const proposal = {
  id: proposalId,
  capability: ability.id,
  description: 'Post a comment on Review the estimate',
  preview: {
    title: task.title,
    audience: 'People with access to the task',
    body: 'The updated estimate is ready to review.',
  },
  status: 'pending',
};

const firstRun: PetRunResponse = {
  id: runId,
  itemId: task.id,
  workspaceId: task.workspaceId,
  brief,
  sourceItemIds: [source.id],
  workspaceScope: false,
  abilities: [ability.id],
  revision: 1,
  status: 'waiting_for_input',
  question,
  proposals: [],
  results: [],
  createdAt: '2026-11-17T12:00:00Z',
  updatedAt: '2026-11-17T12:00:00Z',
};

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  return input instanceof Request ? input.clone().json() : undefined;
}

function showTask(
  initial: PetRunResponse | null,
  {
    messages = [],
    direct = false,
    refuseSource = false,
    refuseStart = false,
    workspaceChat = false,
  }: {
    readonly messages?: readonly { id: string; role: 'user' | 'assistant'; text: string }[];
    readonly direct?: boolean;
    readonly refuseSource?: boolean;
    readonly refuseStart?: boolean;
    readonly workspaceChat?: boolean;
  } = {},
) {
  clearPetDrafts();
  signedIn();
  stubCoreApi({ items: [task, source] });
  const inner = globalThis.fetch;
  const calls: { readonly path: string; readonly body: unknown }[] = [];
  let run = initial;
  let routine: Record<string, unknown> | null = null;
  const renameProposal = initial?.proposals.find((entry) => entry.capability === rename.id);
  let persistedTitle = task.title;
  let conversation = {
    status: 'connected',
    reason: 'Connected',
    canConnect: false,
    revision: 1,
    messages,
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(requestUrl(input), globalThis.location.origin);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (renameProposal && pathname === `/api/v1/items/${task.id}` && method === 'GET') {
      return json({ ...task, title: persistedTitle, properties: { title: persistedTitle } });
    }
    if (pathname === '/api/v1/me/pets/settings') {
      return json({
        revision: 1,
        settings: {
          enabled: true,
          activePetId: petId,
          profiles: [{ id: petId, name: 'Owl', appearance: 'owl', instructions: '' }],
        },
      });
    }
    if (pathname === `${chatRoute}/stream` || pathname === `${workspaceChatRoute}/stream`) {
      return new Response(null, { status: 501 });
    }
    if (pathname === `${chatRoute}/watch` || pathname === `${workspaceChatRoute}/watch`)
      return json(conversation);
    if ((pathname === chatRoute || pathname === workspaceChatRoute) && method === 'POST') {
      const body = await readBody(input, init);
      if (
        typeof body === 'object' &&
        body !== null &&
        'operation' in body &&
        body.operation === 'send' &&
        'text' in body &&
        typeof body.text === 'string'
      ) {
        calls.push({ path: pathname, body });
        conversation = {
          ...conversation,
          revision: conversation.revision + 1,
          messages: [
            ...conversation.messages,
            { id: 'new-chat-message', role: 'user', text: body.text },
            {
              id: 'chat-answer',
              role: 'assistant',
              text: 'A flowchart shows the steps in a process.',
            },
          ],
        };
      }
      return json(conversation);
    }
    if (
      (pathname === route && method === 'GET') ||
      pathname === `/api/v1/workspaces/${task.workspaceId}/pet-runs`
    )
      return json({
        enabled: true,
        abilities: [ability, rename],
        runs: direct || run === null ? [] : [run],
      });
    if (pathname === `${route}/${runId}` && direct) {
      return run === null ? json({ title: 'Job unavailable' }, 404) : json(run);
    }
    if (pathname === '/api/v1/search' && searchParams.get('petWorkspaceId') === task.workspaceId) {
      return json({
        query: workspaceChat ? 'estimate' : 'cost',
        results: [workspaceChat ? task : source],
        limit: 25,
        truncated: false,
      });
    }
    if (pathname === route && method === 'POST') {
      calls.push({ path: pathname, body: await readBody(input, init) });
      if (refuseStart) return json({ code: 'pet_runs.disabled', title: 'Pet work paused' }, 403);
      const start = calls.at(-1)?.body;
      run = {
        ...firstRun,
        ...(typeof start === 'object' &&
        start !== null &&
        'brief' in start &&
        typeof start.brief === 'string'
          ? { brief: start.brief }
          : {}),
        ...(typeof start === 'object' &&
        start !== null &&
        'afterMessageId' in start &&
        typeof start.afterMessageId === 'string'
          ? { afterMessageId: start.afterMessageId }
          : {}),
      };
      return json(run);
    }
    if (pathname === `${route}/${runId}/scope`) {
      calls.push({ path: pathname, body: await readBody(input, init) });
      if (refuseSource)
        return json(
          {
            code: 'pet_runs.invalid',
            title: 'Pet job request failed',
            detail:
              'Choose an available source in this workspace that has not already been shared.',
          },
          422,
        );
      run = { ...firstRun, revision: 2, status: 'running', question: null };
      return json(run);
    }
    if (pathname === `${route}/${runId}/answer`) {
      calls.push({ path: pathname, body: await readBody(input, init) });
      run = {
        ...firstRun,
        revision: 2,
        status: 'waiting_for_approval',
        question: null,
        proposals: [proposal],
      };
      return json(run);
    }
    if (pathname === `${route}/${runId}/proposals/${proposalId}/decision`) {
      calls.push({ path: pathname, body: await readBody(input, init) });
      if (renameProposal) persistedTitle = renamedTitle;
      run = {
        ...(run ?? firstRun),
        revision: 3,
        status: 'completed',
        question: null,
        proposals: [{ ...(renameProposal ?? proposal), status: 'applied' }],
        results: [
          {
            id: proposalId,
            text: renameProposal ? 'Renamed the estimate task' : 'Posted the estimate comment',
            reversible: true,
          },
        ],
      };
      return json(run);
    }
    if (pathname === `${route}/${runId}/steps/${proposalId}/undo`) {
      calls.push({ path: pathname, body: undefined });
      persistedTitle = task.title;
      run = {
        ...(run ?? firstRun),
        revision: 4,
        status: 'completed',
        question: null,
        proposals: [{ ...(renameProposal ?? proposal), status: 'undone' }],
        results: [
          {
            id: proposalId,
            text: renameProposal ? 'Undid the estimate rename' : 'Undid the estimate comment',
            reversible: false,
          },
        ],
      };
      return json(run);
    }
    if (pathname === `${route}/${runId}/retry` && run !== null) {
      calls.push({ path: pathname, body: await readBody(input, init) });
      run = { ...run, failure: null, revision: run.revision + 1, status: 'queued' };
      return json(run);
    }
    if (pathname === routinesRoute && method === 'POST') {
      const body = await readBody(input, init);
      calls.push({ path: pathname, body });
      if (typeof body !== 'object' || body === null) return json({ title: 'Invalid routine' }, 400);
      routine = {
        ...body,
        id: routineId,
        workspaceId: task.workspaceId,
        revision: 1,
        consecutiveFailures: 0,
        disabledReason: null,
        lastRunAt: null,
        createdAt: firstRun.createdAt,
        updatedAt: firstRun.updatedAt,
      };
      return json(routine);
    }
    if (pathname === routinesRoute && method === 'GET') {
      return json({ items: routine === null ? [] : [routine] });
    }
    if (pathname === `/api/v1/automations/${routineId}` && method === 'PUT' && routine !== null) {
      calls.push({ path: pathname, body: await readBody(input, init) });
      routine = { ...routine, enabled: false, revision: 2 };
      return json(routine);
    }
    return inner(input, init);
  });
  renderAt(
    <App />,
    direct
      ? petJobHref(task.workspaceId, task.id, runId, questionId)
      : workspaceChat
        ? `/w/${task.workspaceId}/pet`
        : `/w/${task.workspaceId}?item=${task.id}`,
  );
  return calls;
}

it('starts a job from the message box with the current item only', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  expect(dialog.queryByRole('button', { name: 'Hand to pet' })).toBeNull();
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.click(composer);
  await user.paste('Draw a flowchart for intake and review.');
  await user.click(dialog.getByRole('button', { name: 'Start job' }));

  expect(await dialog.findByRole('textbox', { name: question.text })).toBeVisible();
  expect(composer).toHaveValue('');
  expect(calls).toEqual([
    {
      path: route,
      body: {
        brief: 'Draw a flowchart for intake and review.',
        sourceItemIds: [],
        workspaceScope: false,
        includeTargetText: false,
      },
    },
  ]);
});

it('says where a message goes and lets the person flip it before sending', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.type(composer, 'Create a checklist for launch');
  expect(await dialog.findByText('Starts a job')).toBeVisible();
  expect(dialog.getByRole('button', { name: 'Start job' })).toBeVisible();

  await user.click(dialog.getByRole('button', { name: 'Send as chat' }));
  expect(composer).toHaveFocus();
  expect(dialog.getByText('Sends as chat')).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Send' }));

  expect(await dialog.findByText('A flowchart shows the steps in a process.')).toBeVisible();
  expect(calls.map(({ path }) => path)).toEqual([chatRoute]);
});

it('starts a job from a chat-like message when the person asks for one', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  await user.type(
    await dialog.findByRole('textbox', { name: 'Message Owl' }),
    'What is on my list today?',
  );
  expect(await dialog.findByText('Sends as chat')).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Start a job' }));
  await user.click(dialog.getByRole('button', { name: 'Start job' }));

  expect(await dialog.findByRole('textbox', { name: question.text })).toBeVisible();
  expect(calls).toEqual([
    {
      path: route,
      body: {
        brief: 'What is on my list today?',
        sourceItemIds: [],
        workspaceScope: false,
        includeTargetText: false,
      },
    },
  ]);
});

it("forgets the person's choice once the draft is cleared", async () => {
  showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.type(composer, 'Create a checklist for launch');
  await user.click(await dialog.findByRole('button', { name: 'Send as chat' }));
  expect(dialog.getByText('Sends as chat')).toBeVisible();
  await user.clear(composer);
  await user.type(composer, 'Create a checklist for launch');
  expect(await dialog.findByText('Starts a job')).toBeVisible();
});

it('answers a conversational question in chat', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  await user.type(
    await dialog.findByRole('textbox', { name: 'Message Owl' }),
    'What is a flowchart?',
  );
  await user.click(dialog.getByRole('button', { name: 'Send' }));

  expect(await dialog.findByText('A flowchart shows the steps in a process.')).toBeVisible();
  expect(calls.map(({ path }) => path)).toEqual([chatRoute]);
  expect(calls[0]?.body).toMatchObject({ operation: 'send', text: 'What is a flowchart?' });
});

it('holds a workspace request until a target is picked, with a way back to the draft', async () => {
  const calls = showTask(null, { workspaceChat: true });
  const user = userEvent.setup();
  const dialog = within(await screen.findByRole('dialog', { name: 'Conversation with Owl' }));
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.type(composer, brief);
  const send = dialog.getByRole('button', { name: 'Start job' });
  await user.click(send);
  const picker = await dialog.findByRole('searchbox', { name: 'Find a target' });
  expect(picker).toHaveFocus();
  expect(composer).toHaveAttribute('readonly');
  expect(composer).toHaveValue(brief);
  expect(calls).toEqual([]);

  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  expect(composer).toHaveFocus();
  expect(composer).not.toHaveAttribute('readonly');
  expect(composer).toHaveValue(brief);

  await user.click(send);
  await user.type(await dialog.findByRole('searchbox', { name: 'Find a target' }), 'estimate');
  await user.click(
    await dialog.findByRole('button', { name: 'Choose target Review the estimate' }),
  );
  expect(await screen.findByRole('textbox', { name: question.text }, dialogLoad)).toBeVisible();
  expect(calls).toEqual([
    {
      path: route,
      body: { brief, sourceItemIds: [], workspaceScope: false, includeTargetText: false },
    },
  ]);
});

it('keeps a message in the composer when its job fails to start', async () => {
  const calls = showTask(null, { refuseStart: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.type(composer, brief);
  await user.click(dialog.getByRole('button', { name: 'Start job' }));

  expect(await dialog.findByRole('alert')).toHaveTextContent('Pet work paused');
  expect(composer).toHaveValue(brief);
  expect(calls.map(({ path }) => path)).toEqual([route]);
});

it('starts a scoped job, answers its question, and applies and undoes only the reviewed step', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const work = within(await screen.findByRole('region', { name: 'Pet work' }));
  await user.click(await dialog.findByRole('textbox', { name: 'Message Owl' }));
  await user.paste(brief);
  await user.click(work.getByText('Job options'));
  const inclusion = await work.findByRole('checkbox', { name: 'Include note text' });
  expect(inclusion).not.toBeChecked();
  await user.click(inclusion);
  await user.type(await work.findByRole('searchbox', { name: 'Find a source' }), 'cost');
  await user.click(await work.findByRole('button', { name: 'Add source Cost notes' }));
  await user.click(dialog.getByRole('button', { name: 'Start job' }));
  expect(calls[0]).toEqual({
    path: route,
    body: { brief, sourceItemIds: [source.id], workspaceScope: false, includeTargetText: true },
  });
  const response = await dialog.findByRole('textbox', { name: question.text });
  expect(dialog.getByText(brief).closest('summary')).toHaveFocus();
  await user.click(response);
  await user.paste('The updated estimate');
  await user.click(dialog.getByRole('button', { name: 'Answer' }));
  expect(await dialog.findByText(/The updated estimate is ready to review/)).toBeVisible();
  expect(calls).toHaveLength(2);
  await user.click(dialog.getByRole('button', { name: 'Post comment' }));
  expect(await dialog.findByText('Posted the estimate comment')).toBeVisible();
  await user.click(dialog.getByRole('button', { name: 'Undo' }));
  expect(await dialog.findByText('Undid the estimate comment')).toBeVisible();
  expect(calls.slice(1)).toEqual([
    { path: `${route}/${runId}/answer`, body: { questionId, answer: 'The updated estimate' } },
    { path: `${route}/${runId}/proposals/${proposalId}/decision`, body: { approve: true } },
    { path: `${route}/${runId}/steps/${proposalId}/undo`, body: undefined },
  ]);
}, 30_000);

it('updates the open task title after approving and undoing a pet rename', async () => {
  showTask({
    ...firstRun,
    brief: 'Rename this estimate task.',
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: rename.id,
        description: 'Rename Review the estimate',
        preview: { from: task.title, to: renamedTitle },
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  const title = await screen.findByRole('textbox', { name: 'Note title' }, dialogLoad);
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const approve = await dialog.findByRole('button', { name: 'Rename task' }, dialogLoad);
  expect(title).toHaveValue('Review the estimate');

  await user.click(approve);
  expect(await dialog.findByText('Renamed the estimate task')).toBeVisible();
  await waitFor(() => {
    expect(title).toHaveValue('Review the updated estimate');
  });

  await user.click(dialog.getByRole('button', { name: 'Undo' }));
  expect(await dialog.findByText('Undid the estimate rename')).toBeVisible();
  await waitFor(() => {
    expect(title).toHaveValue('Review the estimate');
  });
}, 30_000);

it('shows the reviewed web address and whether the pet will use a connected session', async () => {
  const publicUrl = 'https://forms.example/status?view=full&reference=a%2Fb';
  const connectedUrl = 'https://forms.example/account';
  const calls = showTask({
    ...firstRun,
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: 'browser.browse',
        description: `Open the web page at ${publicUrl}`,
        preview: { url: publicUrl },
        status: 'pending',
      },
      {
        id: 'aaf1d113-ce45-47d4-bd7c-51a4dd47e4ab',
        capability: 'browser.browse',
        description: `Open the web page at ${connectedUrl}`,
        preview: { url: connectedUrl, connectionId: task.id, connectionRevision: source.id },
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const publicVisit = within(
    await dialog.findByRole('group', { name: `Open the web page at ${publicUrl}` }),
  );
  const connectedVisit = within(
    dialog.getByRole('group', { name: `Open the web page at ${connectedUrl}` }),
  );
  expect(publicVisit.getByText('Public browsing')).toBeVisible();
  expect(connectedVisit.getByText('Uses the connected site session')).toBeVisible();
  expect(connectedVisit.queryByText(/connectionId|connectionRevision/u)).not.toBeInTheDocument();
  expect(calls).toEqual([]);
  await user.click(publicVisit.getByRole('button', { name: 'Open web page' }));
  expect(calls).toEqual([
    { path: `${route}/${runId}/proposals/${proposalId}/decision`, body: { approve: true } },
  ]);
});

it.each([
  {
    stage: 'planning',
    heading: 'Planning stopped',
    code: 'pet_runs.plan_unavailable',
    message: 'The pet could not finish planning this step. Check the connection and retry.',
  },
  {
    stage: 'preview',
    heading: 'Draft could not be prepared',
    code: 'pet_runs.invalid_action',
    message: 'The job has not been granted text from its target note.',
  },
  {
    stage: 'apply',
    heading: 'Change could not be applied',
    code: 'pet_runs.step_unavailable',
    message: 'Nix could not confirm this change. Check its target before deciding what to do next.',
  },
] satisfies readonly (NonNullable<PetRunResponse['failure']> & { readonly heading: string })[])(
  'shows the safe $stage failure and retries the same job',
  async ({ stage, heading, code, message }) => {
    const calls = showTask({
      ...firstRun,
      status: 'failed',
      question: null,
      failure: { stage, code, message },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
    const dialog = within(await screen.findByRole('dialog'));
    const failure = within(await dialog.findByRole('region', { name: 'Job failure' }));
    expect(failure.getByRole('heading', { name: heading })).toBeVisible();
    expect(failure.getByText(message)).toBeVisible();
    expect(failure.queryByText(code)).not.toBeInTheDocument();
    expect(calls).toEqual([]);

    await user.click(dialog.getByRole('button', { name: 'Retry job' }));

    expect(calls).toEqual([{ path: `${route}/${runId}/retry`, body: undefined }]);
    await waitFor(() => {
      expect(dialog.queryByRole('region', { name: 'Job failure' })).not.toBeInTheDocument();
    });
  },
);

it('keeps the generic failure and exact retry for an older job response', async () => {
  const calls = showTask({ ...firstRun, status: 'failed', question: null });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  expect(await dialog.findByText('Job failed', { selector: 'span' })).toBeVisible();
  expect(dialog.queryByRole('region', { name: 'Job failure' })).not.toBeInTheDocument();

  await user.click(dialog.getByRole('button', { name: 'Retry job' }));

  expect(calls).toEqual([{ path: `${route}/${runId}/retry`, body: undefined }]);
});

it('labels a job that waits on an answer with the shared status words', async () => {
  showTask(firstRun);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  expect(await dialog.findByText('Needs an answer', { selector: 'span' })).toBeVisible();
  expect(screen.queryByText('Waiting for your answer')).not.toBeInTheDocument();
});

it('shows a registered tool call as proposed and approves that exact proposal', async () => {
  const call = {
    connectionId: petId,
    connectionRevision: routineId,
    action: 'remote.invoke',
    kind: 'write',
    resourceId: 'https://mcp.test/mcp#lookup',
    destination: 'https://mcp.test/mcp#lookup',
    schemaHash: 'a'.repeat(64),
    arguments: { issueId: 'NIX-37' },
  };
  const calls = showTask({
    ...firstRun,
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: 'connection.action',
        description: `remote.invoke in ${call.destination}`,
        preview: call,
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const group = await dialog.findByRole('group', { name: 'Call lookup' });
  const draft = within(group);
  expect(draft.getByText('Server')).toBeVisible();
  expect(draft.getByText('https://mcp.test/mcp')).toBeVisible();
  expect(draft.getByText('issueId')).toBeVisible();
  expect(draft.getByText('NIX-37')).toBeVisible();
  const text = group.textContent;
  expect(text).not.toContain('{');
  expect(text).not.toContain(call.schemaHash);
  expect(text).not.toContain(call.connectionId);
  expect(calls).toEqual([]);

  await user.click(draft.getByRole('button', { name: 'Approve request' }));
  expect(calls).toEqual([
    { path: `${route}/${runId}/proposals/${proposalId}/decision`, body: { approve: true } },
  ]);
});

it('shows every input of a registered tool call and keeps raw JSON for other previews', async () => {
  const destination = 'https://mcp.test/mcp#search';
  showTask({
    ...firstRun,
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: 'connection.action',
        description: `remote.invoke in ${destination}`,
        preview: {
          action: 'remote.invoke',
          destination,
          arguments: { filter: { state: 'open' }, limit: 5, cursor: null, note: '' },
        },
        status: 'pending',
      },
      {
        id: petId,
        capability: 'connection.action',
        description: 'remote.invoke in https://other.test/mcp#archive',
        preview: {
          action: 'remote.invoke',
          destination: 'https://other.test/mcp#archive',
          arguments: {},
        },
        status: 'declined',
      },
      {
        id: routineId,
        capability: 'connection.action',
        description: 'something.else in x',
        preview: { action: 'something.else', destination: 'x' },
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const plain = within(await dialog.findByRole('group', { name: 'Call search' }));
  expect(plain.getByText('limit')).toBeVisible();
  expect(plain.getByText('5')).toBeVisible();
  expect(plain.getByText('Empty')).toBeVisible();
  expect(plain.getByText('Empty text')).toBeVisible();
  const decided = within(dialog.getByRole('region', { name: 'Call archive' }));
  expect(decided.getByText('https://other.test/mcp')).toBeVisible();
  expect(plain.getByText(/"state": "open"/u)).toBeVisible();
  const raw = within(await dialog.findByRole('group', { name: 'something.else in x' }));
  expect(raw.getByText(/"action": "something.else"/u)).toBeVisible();
});

it('reviews an exact note append as literal text and retains other Nix action previews', async () => {
  const markdown =
    '## Intake\n\n- [ ] Read the quote\n  - [x] <strong>Keep this literal</strong>\n';
  const append = {
    operationId: 'AppendItemBody',
    method: 'POST',
    target: `/api/v1/items/${source.id}/body`,
    inputs: { operationId: 'AppendItemBody', path: { itemId: source.id }, body: { markdown } },
    documentId: source.id,
    headSeq: 1,
  };
  const calls = showTask({
    ...firstRun,
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: 'nix.action',
        description: 'Run AppendItemBody in the selected Nix scope.',
        preview: append,
        status: 'pending',
      },
      {
        id: 'aaf1d113-ce45-47d4-bd7c-51a4dd47e4ab',
        capability: 'nix.action',
        description: 'Legacy append',
        preview: { ...append, inputs: { ...append.inputs, body: { markdown: null } } },
        status: 'pending',
      },
      {
        id: 'baf1d113-ce45-47d4-bd7c-51a4dd47e4ab',
        capability: 'nix.action',
        description: 'Replace note',
        preview: { operationId: 'ReplaceItemBody', inputs: { body: { markdown: 'Replacement' } } },
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const draft = within(await dialog.findByRole('group', { name: 'Add to end of note' }));
  const region = draft.getByRole('region', { name: 'Text to add' });
  expect(region.textContent).toBe(markdown);
  expect(within(region).queryByRole('strong')).not.toBeInTheDocument();
  expect(draft.queryByText(/"documentId"/u)).not.toBeInTheDocument();
  expect(draft.getByRole('link', { name: 'Open target note' })).toHaveAttribute(
    'href',
    `/w/${task.workspaceId}?item=${source.id}`,
  );
  const legacy = within(dialog.getByRole('group', { name: 'Legacy append' }));
  expect(legacy.getByRole('button', { name: 'Approve request' })).toBeVisible();
  expect(legacy.getByText(/"markdown": null/u)).toBeVisible();
  const replace = within(dialog.getByRole('group', { name: 'Replace note' }));
  expect(replace.getByText(/"operationId": "ReplaceItemBody"/u)).toBeVisible();
  expect(calls).toEqual([]);

  await user.click(draft.getByRole('button', { name: 'Add to note' }));
  expect(calls).toEqual([
    { path: `${route}/${runId}/proposals/${proposalId}/decision`, body: { approve: true } },
  ]);
});

it('shows exact sheet changes and preserves the preview for an unsupported change', async () => {
  const cells = [
    { kind: 'cell', cell: 'A1', before: null, after: '12' },
    { kind: 'cell', cell: 'A2', before: '18', after: '30' },
    { kind: 'cell', cell: 'A3', before: '=A1+A2', after: '=SUM(A1:A2)' },
    { kind: 'cell', cell: 'B1', before: 'Draft', after: null },
    { kind: 'extent', axis: 'rows', before: 100, after: 120 },
    { kind: 'width', column: 'B', before: 180, after: null },
  ];
  showTask({
    ...firstRun,
    status: 'waiting_for_approval',
    question: null,
    proposals: [
      {
        id: proposalId,
        capability: 'sheet.edit',
        description: 'Edit sheet Budget',
        preview: { kind: 'sheet', preview: { changes: cells } },
        status: 'pending',
      },
      {
        id: 'aaf1d113-ce45-47d4-bd7c-51a4dd47e4ab',
        capability: 'sheet.edit',
        description: 'Edit sheet Old estimate',
        preview: { kind: 'sheet', preview: { changes: [{ kind: 'merge', range: 'C1:C2' }] } },
        status: 'pending',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const draft = within(await dialog.findByRole('group', { name: 'Edit sheet Budget' }));
  expect(draft.getByRole('button', { name: 'Apply sheet changes' })).toBeVisible();
  const table = within(draft.getByRole('table', { name: 'Sheet changes' }));
  expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
    'Change',
    'Before',
    'After',
  ]);
  expect(
    table
      .getAllByRole('row')
      .slice(1)
      .map((row) => {
        const entries = within(row);
        return [entries.getByRole('rowheader'), ...entries.getAllByRole('cell')].map(
          (cell) => cell.textContent,
        );
      }),
  ).toEqual([
    ['A1', 'Empty', '12'],
    ['A2', '18', '30'],
    ['A3', '=A1+A2', '=SUM(A1:A2)'],
    ['B1', 'Draft', 'Empty'],
    ['Rows', '100', '120'],
    ['Column B width', '180 px', 'Default'],
  ]);

  const legacy = within(dialog.getByRole('group', { name: 'Edit sheet Old estimate' }));
  expect(legacy.queryByRole('table')).not.toBeInTheDocument();
  expect(legacy.getByText(/"range": "C1:C2"/u)).toBeVisible();
});

it('shares only the source selected for a specific job request', async () => {
  const calls = showTask({ ...firstRun, sourceItemIds: [], question: scopeQuestion });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const share = await dialog.findByRole('button', { name: 'Share this source' });
  expect(share).toBeDisabled();
  await user.type(dialog.getByRole('searchbox', { name: 'Find a source' }), 'cost');
  await user.click(await dialog.findByRole('button', { name: 'Add source Cost notes' }));
  await user.click(share);
  expect(calls).toEqual([
    {
      path: `${route}/${runId}/scope`,
      body: {
        questionId,
        approve: true,
        sourceItemId: source.id,
      },
    },
  ]);
});

it('explains when a selected source becomes unavailable and lets the owner choose again', async () => {
  showTask({ ...firstRun, sourceItemIds: [], question: scopeQuestion }, { refuseSource: true });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const picker = await dialog.findByRole('searchbox', { name: 'Find a source' });
  await user.type(picker, 'cost');
  await user.click(await dialog.findByRole('button', { name: 'Add source Cost notes' }));
  const share = dialog.getByRole('button', { name: 'Share this source' });
  await user.click(share);

  expect(await dialog.findByRole('alert')).toHaveTextContent(
    'Choose an available source in this workspace that has not already been shared.',
  );
  expect(picker).toBeEnabled();
  expect(share).toBeDisabled();
});

it('adds the selected chat message as an editable quote and starts a job from it', async () => {
  const quotedMessage = '> Write the review summary.\n> Include the revised budget.';
  const nextDraft = `Please use this instruction.\n\n${quotedMessage}`;
  const calls = showTask(null, {
    messages: [
      { id: 'first', role: 'user', text: 'Earlier private chat context' },
      {
        id: 'last',
        role: 'assistant',
        text: 'Write the review summary.\nInclude the revised budget.',
      },
    ],
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const composer = await dialog.findByRole('textbox', { name: 'Message Owl' });
  await user.type(composer, 'Please use this instruction.');
  const actions = dialog.getAllByRole('button', { name: 'Attach message to a job' });
  const attach = actions.at(-1);
  if (attach === undefined) throw new Error('Missing attachment action');
  await user.click(attach);
  expect(composer).toHaveValue(nextDraft);
  expect(composer).toHaveFocus();
  await user.click(dialog.getByRole('button', { name: 'Start job' }));
  expect(await dialog.findByRole('textbox', { name: question.text })).toBeVisible();
  expect(calls).toEqual([
    {
      path: route,
      body: {
        brief: nextDraft,
        sourceItemIds: [],
        workspaceScope: false,
        includeTargetText: false,
        afterMessageId: 'last',
      },
    },
  ]);
});

it('opens a run outside the activity list and focuses its brief when the question was answered', async () => {
  showTask({ ...firstRun, status: 'completed', question: null }, { direct: true });
  const dialog = within(await screen.findByRole('dialog', {}, dialogLoad));
  expect(await dialog.findByText(brief)).toBeVisible();
  expect(dialog.getByText(brief).closest('summary')).toHaveFocus();
  expect(dialog.queryByRole('button', { name: 'Answer' })).toBeNull();
});

it('saves a named routine with an exact task rename, then pauses that same rule', async () => {
  const calls = showTask(null);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Ask pet' }, dialogLoad));
  const dialog = within(await screen.findByRole('dialog'));
  const work = within(await dialog.findByRole('region', { name: 'Pet work' }));
  await user.click(await dialog.findByRole('textbox', { name: 'Message Owl' }));
  await user.paste('Set the next review title.');
  await user.click(work.getByText('Job options'));
  await user.click(await work.findByRole('checkbox', { name: 'Schedule this job daily' }));
  expect(work.getByRole('checkbox', { name: 'Include note text in each run' })).not.toBeChecked();
  await user.click(work.getByRole('checkbox', { name: rename.name }));
  await user.type(work.getByRole('textbox', { name: 'Routine name' }), 'Daily review');
  await user.click(
    work.getByRole('checkbox', { name: 'Allow this exact title change without review' }),
  );
  expect(work.getByRole('textbox', { name: 'Current title' })).toHaveValue('Review the estimate');
  await user.type(work.getByRole('textbox', { name: 'New title' }), 'Estimate reviewed');
  await user.click(work.getByRole('button', { name: 'Save routine' }));
  expect(await work.findByText('Saved routine “Daily review”.')).toBeVisible();

  const rule = {
    name: 'Daily review',
    enabled: true,
    scopeItemId: task.id,
    trigger: { type: 'schedule', freq: 'daily', time: '09:00', interval: 1 },
    conditions: [],
    actions: [
      {
        type: 'start_pet_run',
        brief: 'Set the next review title.',
        sourceItemIds: [],
        includeTargetText: false,
        abilities: ['task.rename'],
        autoRename: { from: 'Review the estimate', to: 'Estimate reviewed' },
      },
    ],
  };
  expect(calls[0]).toEqual({ path: routinesRoute, body: rule });
  await user.click(work.getByText('Scheduled routines'));
  await user.click(await work.findByRole('button', { name: 'Pause Daily review' }));
  expect(await work.findByText('Daily review · Paused')).toBeVisible();
  expect(calls[1]).toEqual({
    path: `/api/v1/automations/${routineId}`,
    body: { expectedRevision: 1, rule: { ...rule, enabled: false } },
  });
}, 30_000);
