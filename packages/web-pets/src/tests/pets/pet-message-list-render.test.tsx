import { nixSchema } from '@nix/editor-schema';
import { render, renderHook, screen } from '@testing-library/react';
import { Profiler, type ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageList } from '../../pets/conversation/messages/message-list';
import { useReplyAnnouncer } from '../../pets/conversation/state/use-reply-announcer';
import { useStablePieces } from '../../pets/conversation/state/use-stable-pieces';

vi.mock('../../pets/work-tools/pet-work-tools', () => ({ PetWorkTools: () => null }));

const pet = { id: 'p', name: 'Cat', appearance: 'cat' } as never;
const settings = { motion: 'reduced' } as never;
const noop = () => undefined;

/** A fresh message array each tick, as the watch endpoint delivers it: new objects, same text. */
function runtimeAt(tick: number) {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    id: `m${String(index)}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text:
      index % 2 === 0
        ? `Question ${String(index)}`
        : `Answer ${String(index)}\n\n- one\n- two\n- three\n\nDone.`,
  }));
  messages.push({
    id: 'turn:draft:1',
    role: 'assistant',
    text: `Streaming ${'word '.repeat(tick)}`,
  });
  return { state: 'thinking', status: 'connected', messages, tools: [] } as never as {
    messages: { id: string; role: string; text: string }[];
  };
}

function Tick({ tick }: { tick: number }): ReactElement {
  const runtime = runtimeAt(tick);
  const piecesBefore = useStablePieces(runtime.messages);
  return (
    <MemoryRouter>
      <MessageList
        client={{} as never}
        workspaceId="11111111-1111-4111-8111-111111111111"
        pet={pet}
        settings={settings}
        runtime={runtime as never}
        messages={runtime.messages as never}
        piecesBefore={piecesBefore}
        running
        busy={false}
        hasDraft
        approvalPending={false}
        workspaceAccess
        suggestions={[]}
        onPick={noop}
        onAsk={noop}
        setRuntime={noop}
        reportNeedsDecision={noop}
        applyWithoutAsking={false}
        applyExemptToolIds={[]}
        noteScope={undefined}
        editing={null}
        setEditing={noop}
        enterToSend
        resendTurn={noop}
        retryLastTurn={noop}
        onSaveInsight={noop}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('message list while a reply streams', () => {
  it('rebuilds only the streaming reply on each update', () => {
    const build = vi.spyOn(nixSchema, 'nodeFromJSON');
    const view = render(
      <Profiler id="list" onRender={noop}>
        <Tick tick={0} />
      </Profiler>,
    );
    build.mockClear();
    for (let tick = 1; tick <= 10; tick += 1)
      view.rerender(
        <Profiler id="list" onRender={noop}>
          <Tick tick={tick} />
        </Profiler>,
      );
    // 41 messages (40 settled, one draft) over 10 updates. Before memoising: 3060 calls (every
    // reply rebuilt each time). Now only the draft's own nodes (6 per update) are built.
    expect(build.mock.calls.length).toBeLessThanOrEqual(10 * 6);
  });
});

describe('reply announcer', () => {
  const user = { id: 'u1', role: 'user', text: 'Hi' };
  const draft = { id: 'u1:draft:1', role: 'assistant', text: 'Hel' };
  const reply = { id: 'u1:assistant', role: 'assistant', text: 'Hello there' };
  const args = { petName: 'Cat', ready: true, approvalPending: false };

  it('speaks a finished reply once, never a draft, and not history already on screen', () => {
    const { result, rerender } = renderHook(
      (props: { messages: (typeof user)[] }) => useReplyAnnouncer({ ...args, ...props }),
      { initialProps: { messages: [user, { ...reply, id: 'old:assistant' }] } },
    );
    expect(result.current).toBe('');
    rerender({ messages: [user, reply, user, draft] });
    expect(result.current).toBe('Cat: Hello there');
    rerender({ messages: [user, reply, user, { ...draft, text: 'Hello again, a longer draft' }] });
    expect(result.current).toBe('Cat: Hello there');
  });
});

describe('message list turn error', () => {
  it('shows the error after the last message, with the reply actions only when idle', () => {
    const runtime = {
      state: 'error',
      status: 'connected',
      reason: 'It broke',
      messages: [
        { id: 'u1', role: 'user', text: 'Hi' },
        { id: 'u1:assistant', role: 'assistant', text: 'Hello' },
      ],
      tools: [],
    };
    render(
      <MemoryRouter>
        <MessageList
          client={{} as never}
          workspaceId="11111111-1111-4111-8111-111111111111"
          pet={pet}
          settings={settings}
          runtime={runtime as never}
          messages={runtime.messages as never}
          piecesBefore={[]}
          running={false}
          busy={false}
          hasDraft={false}
          approvalPending={false}
          workspaceAccess
          suggestions={[]}
          onPick={noop}
          onAsk={noop}
          setRuntime={noop}
          reportNeedsDecision={noop}
          applyWithoutAsking={false}
          applyExemptToolIds={[]}
          noteScope={undefined}
          editing={null}
          setEditing={noop}
          enterToSend
          resendTurn={noop}
          retryLastTurn={noop}
          onSaveInsight={noop}
        />
      </MemoryRouter>,
    );
    const alert = screen.getByRole('alert');
    expect(screen.getByText('Hello').compareDocumentPosition(alert)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    for (const name of ['Save as note', 'Regenerate', 'Edit message'])
      expect(screen.getAllByRole('button', { name })).toHaveLength(1);
  });
});
