import { describe, expect, it } from 'vitest';

import { runtime, streamRuntimeRequest, watchRuntime } from './pets.js';

const WORKSPACE_ID = 'a1000000-0000-4000-8000-000000000001';
const PET_ID = 'a2000000-0000-4000-8000-000000000002';
const ROOT_ITEM_ID = 'a3000000-0000-4000-8000-000000000003';

describe('the pets resource', () => {
  it('opens the conversation stream on the chat or the note path', () => {
    expect(
      streamRuntimeRequest({ workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat' }),
    ).toEqual({
      path: '/api/v1/me/pets/runtime/stream',
      body: { workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat' },
    });
    expect(
      streamRuntimeRequest({ workspaceId: WORKSPACE_ID, petId: PET_ID, rootItemId: ROOT_ITEM_ID }),
    ).toEqual({
      path: '/api/v1/me/pets/runtime/note/stream',
      body: { workspaceId: WORKSPACE_ID, petId: PET_ID, rootItemId: ROOT_ITEM_ID, mode: '' },
    });
  });

  it('keeps the note conversation scope on runtime and watch requests', () => {
    expect(
      runtime({
        operation: 'send',
        workspaceId: WORKSPACE_ID,
        petId: PET_ID,
        rootItemId: ROOT_ITEM_ID,
        readOnly: true,
      }),
    ).toMatchObject({
      path: '/api/v1/me/pets/runtime/note',
      body: { rootItemId: ROOT_ITEM_ID, readOnly: true },
    });
    expect(runtime({ operation: 'read' }).body).toMatchObject({
      rootItemId: null,
      readOnly: false,
    });
    expect(
      watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID, rootItemId: ROOT_ITEM_ID }),
    ).toMatchObject({
      path: '/api/v1/me/pets/runtime/note/watch',
      query: { rootItemId: ROOT_ITEM_ID },
    });
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID }).query).not.toHaveProperty(
      'rootItemId',
    );
  });

  it('runtime carries the attached items and the turn a send replaces, null when unused', () => {
    const replaced = '99999999-9999-4999-8999-999999999999';
    expect(
      runtime({
        operation: 'send',
        itemIds: [ROOT_ITEM_ID, PET_ID],
        replaceFromMessageId: replaced,
      }).body,
    ).toMatchObject({ itemIds: [ROOT_ITEM_ID, PET_ID], replaceFromMessageId: replaced });
    expect(runtime({ operation: 'send' }).body).toMatchObject({
      itemIds: null,
      replaceFromMessageId: null,
    });
  });

  it('runtime is a POST whose body never carries after; only watchRuntime reads it', () => {
    const built = runtime({ operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID });
    expect(built).toMatchObject({
      kind: 'command',
      method: 'POST',
      path: '/api/v1/me/pets/runtime',
      body: { operation: 'read', workspaceId: WORKSPACE_ID, petId: PET_ID },
    });
    expect(built.body).not.toHaveProperty('after');
  });

  it('runtime sends the owner date, zone and workspace map, defaulting each to empty', () => {
    const sent = runtime({
      operation: 'send',
      workspaceId: WORKSPACE_ID,
      petId: PET_ID,
      today: '2026-10-09',
      timeZone: 'Europe/London',
      workspaceMap: [
        { id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] },
        { id: PET_ID, title: 'Log', type: 'note' },
      ],
    });
    expect(sent.body).toMatchObject({
      today: '2026-10-09',
      timeZone: 'Europe/London',
      workspaceMap: [
        { id: WORKSPACE_ID, title: 'Tasks', type: 'note', viewKinds: ['board'] },
        { id: PET_ID, title: 'Log', type: 'note', viewKinds: null },
      ],
    });
    expect(runtime({ operation: 'read' }).body).toMatchObject({
      today: '',
      timeZone: '',
      workspaceMap: null,
    });
  });

  it('carries the locked-content mark both ways, defaulting to unmarked', async () => {
    const { petConnectionSchema } = await import('../schemas/pets.js');
    expect(runtime({ operation: 'tool_result', toolLockedContent: true }).body).toMatchObject({
      toolLockedContent: true,
    });
    expect(runtime({ operation: 'read' }).body).toMatchObject({ toolLockedContent: false });
    const base = { provider: 'chatgpt', status: 'connected', reason: '', canConnect: false };
    expect(petConnectionSchema.parse(base).lockedRead).toBe(false);
    expect(petConnectionSchema.parse({ ...base, lockedRead: true }).lockedRead).toBe(true);
  });

  it('a message parses without any actions member', async () => {
    const { petMessageSchema } = await import('../schemas/pets.js');
    expect(petMessageSchema.parse({ id: 'm', role: 'assistant', text: 'Hi', actions: [] })).toEqual(
      {
        id: 'm',
        role: 'assistant',
        text: 'Hi',
      },
    );
  });

  it('watchRuntime is a GET carrying workspaceId, petId and after as query parameters', () => {
    expect(
      watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 }),
    ).toMatchObject({
      kind: 'query',
      operation: 'pets.watchRuntime',
      timeoutMs: 35_000,
      path: '/api/v1/me/pets/runtime/watch',
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, mode: 'chat', after: 42 },
    });
  });

  it('watchRuntime defaults after to 0 and omits mode when not given', () => {
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID })).toMatchObject({
      query: { workspaceId: WORKSPACE_ID, petId: PET_ID, after: 0 },
    });
    expect(watchRuntime({ workspaceId: WORKSPACE_ID, petId: PET_ID }).query).not.toHaveProperty(
      'mode',
    );
  });
});
