import { describe, expect, it } from 'vitest';

import { readMessage } from '../schemas/messages.js';
import { approvePetTurn, directory, dismissPetTurn, petTurns, post } from './messages.js';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ITEM = '11111111-1111-4111-8111-111111111111';
const PERSON = '33333333-3333-4333-8333-333333333333';

describe('the messages resource', () => {
  it('posts under an item with an explicit addressee list and refreshes the tree', () => {
    expect(
      post(WORKSPACE, ITEM, { text: 'hi', to: [{ id: PERSON, kind: 'person' }] }),
    ).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${ITEM}/messages`,
      body: { text: 'hi', to: [{ id: PERSON, kind: 'person' }] },
      invalidates: [
        ['items', ITEM],
        ['workspaces', WORKSPACE, 'items'],
      ],
    });
    expect(post(WORKSPACE, ITEM, { text: 'hi' }).body).toEqual({ text: 'hi', to: [] });
  });

  it('reads where each addressed pet stands, and approves or dismisses a waiting turn', () => {
    expect(petTurns(ITEM)).toMatchObject({ path: `/api/v1/items/${ITEM}/pet-turns` });
    expect(approvePetTurn(ITEM, PERSON)).toMatchObject({
      method: 'POST',
      path: `/api/v1/items/${ITEM}/pet-turns/${PERSON}/approve`,
    });
    expect(dismissPetTurn(ITEM, PERSON).path).toBe(
      `/api/v1/items/${ITEM}/pet-turns/${PERSON}/dismiss`,
    );
  });

  it('reads the directory with an optional search', () => {
    expect(directory(ITEM)).toMatchObject({ path: `/api/v1/items/${ITEM}/message-directory` });
    expect(directory(ITEM, 'ad')).toMatchObject({ query: { query: 'ad' } });
  });
});

describe('readMessage', () => {
  const stored = JSON.stringify({
    text: 'hello',
    author: { id: PERSON, kind: 'person', name: 'Ada', via: 'Claude' },
    to: [{ id: ITEM, kind: 'pet', name: 'Pip' }],
  });

  it('reads the server-owned property of a message item', () => {
    expect(readMessage({ type: 'message', properties: { $message: stored } })).toMatchObject({
      text: 'hello',
      author: { name: 'Ada', via: 'Claude' },
      to: [{ name: 'Pip' }],
    });
  });

  it('returns null for another kind, a missing property or damaged JSON', () => {
    expect(readMessage({ type: 'note', properties: { $message: stored } })).toBeNull();
    expect(readMessage({ type: 'message', properties: {} })).toBeNull();
    expect(readMessage({ type: 'message', properties: { $message: '{' } })).toBeNull();
    expect(readMessage({ type: 'message', properties: { $message: '{"text":1}' } })).toBeNull();
  });
});
