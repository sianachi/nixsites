import { item, stubCoreApi } from '@nix/web-foundation/testing/api-stub';
import { json } from '@nix/web-foundation/testing/json-response';
import { requestUrl } from '@nix/web-foundation/testing/request-url';
import { renderAt, signedIn } from '@nix/web-editor/testing/render-with-router';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { App } from '../../app';

const task = item({
  id: '40784fc7-c88e-44c5-a236-a729448b29bb',
  title: 'Triage customer requests',
});
const connectionId = 'd1708f48-f821-49a9-94cc-d46ab67e879c';
const connectionRevision = 'f9ab082c-9d96-45a7-9ea0-90a75155ebfd';
const ruleId = 'ac888d56-d6da-4fda-94e9-396fac3203c9';
const petId = '1b3f853b-86a9-4350-bc89-b34173a6502c';
const panelLoad = { timeout: 5_000 };

it.each([
  {
    provider: 'gmail',
    owner: 'google',
    kind: 'gmail-label',
    label: 'Gmail',
    actions: ['gmail.checkpoint', 'gmail.list-changes', 'gmail.get-message'],
  },
  {
    provider: 'outlook-mail',
    owner: 'microsoft',
    kind: 'folder',
    label: 'Outlook',
    actions: ['outlook-mail.poll-folder', 'outlook-mail.get-message'],
  },
])(
  'saves a daily task mailbox watch for $label',
  async ({ provider, owner, kind, label, actions }) => {
    signedIn();
    stubCoreApi({ items: [task] });
    const inner = globalThis.fetch;
    const payloads: unknown[] = [];
    const workspacePath = `/api/v1/workspaces/${task.workspaceId}`;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(requestUrl(input), globalThis.location.origin);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
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
      if (pathname === `/api/v1/items/${task.id}/pet-runs`) {
        return json({ enabled: true, abilities: [], runs: [] });
      }
      if (pathname === `${workspacePath}/pet-connections`) {
        return json({
          enabled: true,
          connections: [
            {
              id: connectionId,
              provider: owner,
              resourceKind: kind,
              resourceId: 'Intake',
              revision: connectionRevision,
              actions,
            },
          ],
          actions: [],
          calendars: [],
        });
      }
      if (pathname === `${workspacePath}/automations` && method === 'POST') {
        const body: unknown =
          typeof init?.body === 'string'
            ? JSON.parse(init.body)
            : await (input instanceof Request ? input.clone().json() : null);
        payloads.push(body);
        if (typeof body !== 'object' || body === null)
          return json({ title: 'Invalid routine' }, 400);
        return json({
          ...body,
          id: ruleId,
          workspaceId: task.workspaceId,
          revision: 1,
          consecutiveFailures: 0,
          disabledReason: null,
          lastRunAt: null,
          createdAt: '2026-11-17T12:00:00Z',
          updatedAt: '2026-11-17T12:00:00Z',
        });
      }
      return inner(input, init);
    });
    renderAt(<App />, `/w/${task.workspaceId}?item=${task.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ask pet' }, panelLoad));
    const work = within(await screen.findByRole('region', { name: 'Pet work' }, panelLoad));
    await user.click(await work.findByText('Job options', {}, panelLoad));
    await user.click(await work.findByText('Watch a mailbox'));
    expect(work.getByRole('option', { name: `${label} · Intake` })).toHaveValue(connectionId);
    const instruction = work.getByRole('textbox', {
      name: 'What should your pet do with new mail?',
    });
    await user.type(instruction, 'Draft the next triage step.');
    await user.click(work.getByRole('button', { name: 'Start watching' }));
    expect(await work.findByText('Mailbox watch scheduled.')).toBeVisible();
    expect(instruction).toHaveValue('');
    expect(payloads).toEqual([
      {
        name: `Watch ${label} · Intake`,
        enabled: true,
        scopeItemId: task.id,
        trigger: { type: 'schedule', freq: 'daily', interval: 1, time: '09:00' },
        conditions: [],
        actions: [
          {
            type: 'poll_pet_mailbox',
            provider,
            connectionId,
            connectionRevision,
            resourceId: 'Intake',
            brief: 'Draft the next triage step.',
            includeTargetText: false,
          },
        ],
      },
    ]);
  },
);
