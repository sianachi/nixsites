import type { PetToolCall } from '@nix/api-client';
import { renderHook } from '@testing-library/react';
import { DECLINED_BY_USER, toolOutcomeSentence } from '../../pets/work-tools/receipts';
import { describe, expect, it } from 'vitest';
import { useReplyAnnouncer } from '../../pets/conversation/state/use-reply-announcer';

interface Message {
  id: string;
  role: string;
  text: string;
}
const user = (id: string): Message => ({ id, role: 'user', text: 'hi' });
const reply = (id: string, text = id): Message => ({ id, role: 'assistant', text });

interface Props {
  messages: Message[];
  approvalPending?: boolean;
  outcome?: string;
}
function setup(messages: Message[]) {
  return renderHook<string, Props>(
    (props) => useReplyAnnouncer({ petName: 'Cat', ready: true, approvalPending: false, ...props }),
    { initialProps: { messages } },
  );
}

describe('useReplyAnnouncer', () => {
  it('speaks a second approval wait again after the first ended', () => {
    const view = setup([]);
    view.rerender({ messages: [], approvalPending: true });
    expect(view.result.current).toBe('Cat is waiting for your approval');
    view.rerender({ messages: [], approvalPending: false });
    expect(view.result.current).toBe('');
    view.rerender({ messages: [], approvalPending: true });
    expect(view.result.current.replace('​', '')).toBe('Cat is waiting for your approval');
  });

  it('speaks two consecutive replies with the same text as separate changes', () => {
    const view = setup([user('u1')]);
    view.rerender({ messages: [user('u1'), reply('a1', 'Done.')] });
    const first = view.result.current;
    view.rerender({
      messages: [user('u1'), reply('a1', 'Done.'), user('u2'), reply('a2', 'Done.')],
    });
    expect(view.result.current).not.toBe(first);
    expect(view.result.current.replace('​', '')).toBe('Cat: Done.');
  });

  it('does not read an earlier reply that became the last one after Regenerate', () => {
    const view = setup([user('u1'), reply('a1'), user('u2'), reply('a2')]);
    view.rerender({ messages: [user('u1'), reply('a1'), user('u2')] });
    expect(view.result.current).toBe('');
  });

  it('says nothing for an outcome already there when the chat opened', () => {
    const view = renderHook(() =>
      useReplyAnnouncer({
        messages: [],
        petName: 'Cat',
        ready: true,
        approvalPending: false,
        outcome: 'Stopped after 2 of 5',
      }),
    );
    expect(view.result.current).toBe('');
  });

  it('words a stopped build and a failed write, and nothing for a clean finish or a decline', () => {
    const tool = (status: PetToolCall['status'], result = ''): PetToolCall => ({
      id: 't',
      arguments: '{}',
      status,
      result,
      claimId: '',
    });
    const stopped = JSON.stringify({
      complete: false,
      rootId: null,
      ledger: [
        { nodeId: 'a', status: 'done' },
        { nodeId: 'b', status: 'pending' },
      ],
    });
    expect(toolOutcomeSentence(tool('completed', stopped))).toBe(
      'Stopped after 1 of 2. The draft is incomplete.',
    );
    expect(toolOutcomeSentence(tool('failed'))).toContain("Didn't finish");
    expect(toolOutcomeSentence(tool('completed', 'created'))).toBe('');
    expect(toolOutcomeSentence(tool('failed', DECLINED_BY_USER))).toBe('');
  });

  it('speaks an outcome once, through the same region', () => {
    const view = setup([]);
    view.rerender({ messages: [], outcome: 'Stopped after 2 of 5' });
    expect(view.result.current).toBe('Stopped after 2 of 5');
  });
});
