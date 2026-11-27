import { describe, expect, it } from 'vitest';
import { conversationMemorySource } from '../../pets/memory-mode';

const ID = '33333333-3333-4333-8333-333333333333';

describe('conversationMemorySource', () => {
  it('names the conversation and cleans its title', () => {
    expect(conversationMemorySource({ conversationId: ID, title: 'Plan\u0007​!' })).toEqual({
      kind: 'conversation',
      id: ID,
      title: 'Plan!',
      author: 'You',
    });
  });

  it('is absent before the chat has an item', () => {
    expect(conversationMemorySource({ conversationId: '', title: 'x' })).toBeUndefined();
  });
});
