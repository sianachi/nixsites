import { describe, expect, it } from 'vitest';

import { IDS, request } from '../testing/testing.ts';
import { parseRequest, validRequest } from './validation.ts';

describe('request boundary', () => {
  it('accepts a valid request and refuses unknown operations, traversal and oversize context', () => {
    expect(validRequest(request())).toBe(true);
    for (const operation of [
      'command/exec',
      'thread/read',
      '../../auth.json',
      'approve',
      'inline',
    ]) {
      expect(validRequest(request({ operation }))).toBe(false);
    }
    expect(validRequest(request({ principalId: '../../another-user' }))).toBe(false);
    expect(validRequest(request({ sharedText: 'a'.repeat(16001) }))).toBe(false);
    expect(validRequest(request({ mode: 'design' }))).toBe(false);
    expect(validRequest(request({ mode: 'consult' }))).toBe(true);
  });

  it('counts lengths in UTF-16 units, not bytes', () => {
    expect(validRequest(request({ text: 'é'.repeat(8000) }))).toBe(true);
    expect(validRequest(request({ text: 'é'.repeat(8001) }))).toBe(false);
    expect(
      validRequest(request({ operation: 'rename', historyId: '', text: 'é'.repeat(120) })),
    ).toBe(true);
    expect(validRequest(request({ operation: 'rename', text: 'é'.repeat(121) }))).toBe(false);
    // An astral character is two UTF-16 units.
    expect(validRequest(request({ operation: 'rename', text: '😀'.repeat(61) }))).toBe(false);
    expect(
      validRequest(
        request({ operation: 'tool_result', toolId: 't', toolResult: 'x'.repeat(32000) }),
      ),
    ).toBe(true);
    expect(
      validRequest(
        request({ operation: 'tool_result', toolId: 't', toolResult: 'x'.repeat(32001) }),
      ),
    ).toBe(false);
  });

  it('bounds the turn context', () => {
    expect(validRequest(request({ today: '2026-10-05', timeZone: 'Europe/London' }))).toBe(true);
    expect(validRequest(request({ today: '2026-13-05' }))).toBe(false);
    expect(validRequest(request({ today: '05/10/2026' }))).toBe(false);
    expect(validRequest(request({ timeZone: 'Europe/London; rm -rf' }))).toBe(false);
    const entry = { id: IDS.item, title: 'Home', type: 'note' };
    expect(validRequest(request({ workspaceMap: Array.from({ length: 40 }, () => entry) }))).toBe(
      true,
    );
    expect(validRequest(request({ workspaceMap: Array.from({ length: 41 }, () => entry) }))).toBe(
      false,
    );
    expect(
      validRequest(
        request({ workspaceMap: [{ ...entry, viewKinds: Array(13).fill('list') as string[] }] }),
      ),
    ).toBe(false);
    expect(
      validRequest(
        request({ items: Array.from({ length: 5 }, () => ({ id: IDS.item, title: 't' })) }),
      ),
    ).toBe(true);
    expect(
      validRequest(
        request({ items: Array.from({ length: 6 }, () => ({ id: IDS.item, title: 't' })) }),
      ),
    ).toBe(false);
    expect(validRequest(request({ items: [{ id: 'nope', title: 't' }] }))).toBe(false);
  });

  it('needs a request id and non-blank text to send, and a request id and tool id for tool calls', () => {
    expect(validRequest(request({ text: '   ' }))).toBe(false);
    expect(validRequest(request({ requestId: 'x' }))).toBe(false);
    expect(validRequest(request({ operation: 'tool_claim', toolId: '' }))).toBe(false);
    expect(validRequest(request({ operation: 'tool_claim', toolId: 'call' }))).toBe(true);
    expect(validRequest(request({ operation: 'resume_history', historyId: 'x' }))).toBe(false);
    expect(validRequest(request({ replaceFromMessageId: IDS.other }))).toBe(true);
    expect(validRequest(request({ operation: 'read', replaceFromMessageId: IDS.other }))).toBe(
      false,
    );
  });

  it('accepts a tool image only as a JPEG data URL on a tool result', () => {
    const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    expect(validRequest(request({ operation: 'tool_result', toolId: 't', toolImage: image }))).toBe(
      true,
    );
    expect(validRequest(request({ operation: 'send', toolImage: image }))).toBe(false);
    expect(
      validRequest(
        request({ operation: 'tool_result', toolId: 't', toolImage: 'data:image/png;base64,AAAA' }),
      ),
    ).toBe(false);
    expect(
      validRequest(
        request({
          operation: 'tool_result',
          toolId: 't',
          toolImage: `data:image/jpeg;base64,${'A'.repeat(1_000_000)}`,
        }),
      ),
    ).toBe(false);
  });

  it('keeps the connection operations to status, connect, disconnect and models', () => {
    for (const operation of ['status', 'connect', 'disconnect', 'models']) {
      expect(validRequest(request({ operation, workspaceId: '', petId: '' }))).toBe(true);
    }
  });

  it('refuses unknown fields, wrong types and trailing content, at any depth', () => {
    const base = { tenantId: IDS.tenant, principalId: IDS.principal, operation: 'status' };
    expect(parseRequest(JSON.stringify(base))).not.toBeNull();
    expect(parseRequest(JSON.stringify({ ...base, extra: 1 }))).toBeNull();
    for (const key of ['__proto__', 'constructor', 'hasOwnProperty'])
      expect(parseRequest(`{"${key}":{},${JSON.stringify(base).slice(1)}`), key).toBeNull();
    expect(parseRequest(JSON.stringify({ ...base, text: 5 }))).toBeNull();
    expect(parseRequest(JSON.stringify({ ...base, after: 1.5 }))).toBeNull();
    expect(
      parseRequest(JSON.stringify({ ...base, items: [{ id: IDS.item, title: 't', x: 1 }] })),
    ).toBeNull();
    expect(
      parseRequest(
        JSON.stringify({ ...base, earlierMessages: [{ id: 'a', role: 'user', text: 't', x: 1 }] }),
      ),
    ).toBeNull();
    expect(parseRequest(`${JSON.stringify(base)} {}`)).toBeNull();
    expect(parseRequest('[]')).toBeNull();
    expect(parseRequest(JSON.stringify({ ...base, text: null }))?.text).toBe('');
  });

  it('mirrors the saved-conversation rules', () => {
    const chat = request({
      operation: 'send',
      conversationItemId: IDS.item,
      readOnly: true,
      workspaceAccess: true,
      sourceWorkspaceIds: [IDS.workspace],
    });
    expect(validRequest(chat)).toBe(true);
    expect(validRequest({ ...chat, readOnly: false })).toBe(false);
    expect(validRequest({ ...chat, workspaceAccess: false })).toBe(false);
    expect(validRequest({ ...chat, rootItemId: IDS.item })).toBe(false);
    expect(validRequest({ ...chat, sourceWorkspaceIds: [] })).toBe(false);
    expect(validRequest({ ...chat, sourceWorkspaceIds: [IDS.workspace, IDS.workspace] })).toBe(
      false,
    );
    expect(validRequest({ ...chat, operation: 'reset' })).toBe(false);
    expect(validRequest({ ...chat, earlierMessages: [{ id: 'm', role: 'tool', text: '' }] })).toBe(
      false,
    );
    expect(
      validRequest({
        ...chat,
        earlierMessages: [{ id: 'm', role: 'user', text: 'x'.repeat(128001) }],
      }),
    ).toBe(false);
    // Without a conversation id the scope fields must be empty.
    expect(validRequest(request({ sourceWorkspaceIds: [IDS.workspace] }))).toBe(false);
  });
});
